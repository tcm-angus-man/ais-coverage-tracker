import type { Pool } from "pg";
import type { ShipRow, VoyageCellRow, SilverCellRow } from "./types";
import { VOYAGE_START, SILVER_START } from "./types";

// All queries use parameterised inputs. Per .claude/rules/code-style.md:
// never concatenate values into SQL strings.
//
// Schema notes (confirmed 2026-05-05):
//   ships.mmsi: numeric (cast ::int — fits in 32 bits, ~10 digits max)
//   ships.imo_number: numeric (cast ::text — type declares string)
//   ships.is_river_cruise_ship: boolean (default false)
//   ships.notes: nullable text (used to dedupe ships sharing one mmsi)
//   voyages: ship_id, start_date, end_date, is_deleted, visible_on_globe,
//            route_file_location, globe_customer_notification
//   prints: voyage_id, is_deleted
//   ais_silver_summary: (mmsi, date, row_count, delta_time_count,
//                        delta_distance_count, spike_count, overland_count)
//
// Open clarification (assumption used here, marked TODO):
//   - `np` ("no print") on voyage cells: no obvious source given the
//     universe is print-linked voyages. Set to 0 pending product call.

// Universe of mmsis to include in the snapshot. Voyage side: ships with
// mmsi, not river cruise, with at least one undeleted voyage. Silver side:
// mmsis appearing in ais_silver_summary that map to a non-river-cruise
// ship row. We dedupe by mmsi preferring the row with notes IS NULL.
export async function fetchShips(pool: Pool): Promise<ShipRow[]> {
  const result = await pool.query<ShipRow>(`
    WITH voyage_universe AS (
      SELECT DISTINCT s.mmsi
      FROM ships s
      WHERE s.is_river_cruise_ship = FALSE
        AND s.mmsi IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM voyages v
          WHERE v.ship_id = s.id
            AND v.is_deleted = FALSE
        )
    ),
    silver_universe AS (
      SELECT DISTINCT ass.mmsi::numeric AS mmsi
      FROM ais_silver_summary ass
      WHERE EXISTS (
        SELECT 1 FROM ships s
        WHERE s.mmsi = ass.mmsi
          AND s.is_river_cruise_ship = FALSE
      )
    ),
    mmsi_universe AS (
      SELECT mmsi FROM voyage_universe
      UNION
      SELECT mmsi FROM silver_universe
    ),
    deduped AS (
      SELECT DISTINCT ON (s.mmsi)
        s.id,
        s.mmsi,
        s.name,
        s.display_name,
        s.cruise_line,
        s.imo_number,
        s.in_service,
        s.notes
      FROM ships s
      JOIN mmsi_universe u ON u.mmsi = s.mmsi
      WHERE s.is_river_cruise_ship = FALSE
      ORDER BY s.mmsi, (s.notes IS NULL) DESC, s.id ASC
    )
    SELECT
      d.id,
      d.mmsi::int AS mmsi,
      COALESCE(d.name, '')::text AS name,
      COALESCE(d.display_name, d.name, '')::text AS display_name,
      COALESCE(d.cruise_line, '')::text AS cruise_line,
      COALESCE(d.imo_number::text, '') AS imo_number,
      COALESCE(d.in_service, FALSE) AS in_service
    FROM deduped d
    ORDER BY display_name ASC NULLS LAST
  `);
  return result.rows;
}

// Voyage cells: per (mmsi, calendar day), counts voyages covering that day
// (not prints — the heatmap visualizes voyage *coverage*, not demand).
//
// Three CTEs:
//   active_ships: per-mmsi active range [first voyage start, last voyage end]
//                 clipped to [VOYAGE_START, today]
//   voyage_days:  per (mmsi, day), the four voyage-derived counts
//   gap_days:     per (mmsi, day), days inside active range with no voyages
//
// gap_days produces np=1 cells so the heatmap can show "no request" gaps
// between a ship's voyages (e.g. ship requested Jan 1–10 then Jan 12–20:
// Jan 11 is a gap day, marked np=1).
export async function fetchVoyageCells(pool: Pool): Promise<VoyageCellRow[]> {
  const result = await pool.query<VoyageCellRow>(
    `
    WITH active_ships AS (
      SELECT
        s.id,
        s.mmsi,
        GREATEST(MIN(v.start_date), $1::date) AS active_start,
        LEAST(MAX(v.end_date), CURRENT_DATE)  AS active_end
      FROM ships s
      JOIN voyages v ON v.ship_id = s.id
      WHERE s.is_river_cruise_ship = FALSE
        AND s.mmsi IS NOT NULL
        AND v.is_deleted = FALSE
        AND v.start_date IS NOT NULL
        AND v.end_date IS NOT NULL
        AND v.end_date >= $1::date
        AND v.start_date <= CURRENT_DATE
      GROUP BY s.id, s.mmsi
    ),
    voyage_days AS (
      SELECT
        s.mmsi,
        d::date AS day,
        COUNT(*)::int AS t,
        COUNT(*) FILTER (WHERE v.visible_on_globe = TRUE)::int AS v,
        COUNT(*) FILTER (
          WHERE v.route_file_location IS NULL
             OR v.globe_customer_notification = 'No data available'
        )::int AS na,
        COUNT(*) FILTER (
          WHERE v.globe_customer_notification = 'Details are wrong'
        )::int AS dw
      FROM voyages v
      JOIN ships s ON s.id = v.ship_id
      CROSS JOIN LATERAL generate_series(
        GREATEST(v.start_date, $1::date),
        LEAST(v.end_date, CURRENT_DATE),
        '1 day'::interval
      ) AS d
      WHERE v.is_deleted = FALSE
        AND s.is_river_cruise_ship = FALSE
        AND s.mmsi IS NOT NULL
        AND v.start_date IS NOT NULL
        AND v.end_date IS NOT NULL
        AND v.end_date >= $1::date
        AND v.start_date <= CURRENT_DATE
      GROUP BY s.mmsi, d::date
    )
    SELECT
      a.mmsi::int AS mmsi,
      to_char(d::date, 'YYYY-MM-DD') AS date,
      COALESCE(vd.t,  0)::int AS t,
      COALESCE(vd.v,  0)::int AS v,
      COALESCE(vd.na, 0)::int AS na,
      COALESCE(vd.dw, 0)::int AS dw,
      (CASE WHEN vd.t IS NULL OR vd.t = 0 THEN 1 ELSE 0 END)::int AS np
    FROM active_ships a
    CROSS JOIN LATERAL generate_series(
      a.active_start,
      a.active_end,
      '1 day'::interval
    ) AS d
    LEFT JOIN voyage_days vd
      ON vd.mmsi = a.mmsi AND vd.day = d::date
    `,
    [VOYAGE_START],
  );
  return result.rows;
}

// Silver cells: ais_silver_summary already keyed on (mmsi, date). One row
// per ship-day. `t` is row_count; `v` is row_count when all four anomaly
// counts are zero (i.e. clean), else 0. The four QA counts pass through
// as dt/dd/sp/ol per docs/plan.md Decisions §5.
export async function fetchSilverCells(pool: Pool): Promise<SilverCellRow[]> {
  const result = await pool.query<SilverCellRow>(
    `
    SELECT
      ass.mmsi::int AS mmsi,
      to_char(ass.date, 'YYYY-MM-DD') AS date,
      COALESCE(ass.row_count, 0)::int AS t,
      (CASE
        WHEN COALESCE(ass.delta_time_count, 0)
           + COALESCE(ass.delta_distance_count, 0)
           + COALESCE(ass.spike_count, 0)
           + COALESCE(ass.overland_count, 0) = 0
        THEN COALESCE(ass.row_count, 0)
        ELSE 0
      END)::int AS v,
      0 AS na,
      0 AS dw,
      0 AS np,
      COALESCE(ass.delta_time_count, 0)::int     AS dt,
      COALESCE(ass.delta_distance_count, 0)::int AS dd,
      COALESCE(ass.spike_count, 0)::int          AS sp,
      COALESCE(ass.overland_count, 0)::int       AS ol
    FROM ais_silver_summary ass
    WHERE ass.date >= $1::date
      AND ass.date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM ships s
        WHERE s.mmsi = ass.mmsi
          AND s.is_river_cruise_ship = FALSE
      )
    `,
    [SILVER_START],
  );
  return result.rows;
}

// Date axis = voyage window (the wider of the two), per snapshot-conventions.
export function buildDateAxis(): string[] {
  const start = new Date(`${VOYAGE_START}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates: string[] = [];
  for (
    let d = start;
    d.getTime() <= today.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
