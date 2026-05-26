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

// Universe of ships to include in the snapshot. A ship qualifies when:
//   - is_river_cruise_ship = FALSE
//   - mmsi IS NOT NULL
//   - has ≥1 voyage that is undeleted, visible_on_globe = TRUE, starts
//     after 2015-01-01, and has ≥1 undeleted print with is_cruise_globe=TRUE
//
// Multiple ship rows can share one mmsi (a hull renamed/resold keeps its
// AIS identifier). We surface ALL such ships as separate rows; voyage_cells
// and silver_cells are still keyed by mmsi, so duplicate-mmsi rows share
// coverage data — that's intended, since AIS history is per-hull.
// Kept in sync with scripts/fill-shared-mmsi.ts and scripts/prune-shared-mmsi.ts
// so the snapshot universe and the ship_metadata sheet stay aligned.
export async function fetchShips(pool: Pool): Promise<ShipRow[]> {
  // Metadata fields (cruise_type, service_start, service_end, tier) are
  // joined onto each row by buildSnapshot() from Google Sheets, not Postgres.
  // We default them here so the row type is internally consistent.
  const result = await pool.query<ShipRow>(`
    SELECT
      s.id,
      s.mmsi::int AS mmsi,
      COALESCE(s.name, '')::text AS name,
      COALESCE(s.display_name, s.name, '')::text AS display_name,
      COALESCE(s.cruise_line, '')::text AS cruise_line,
      COALESCE(s.imo_number::text, '') AS imo_number,
      COALESCE(s.in_service, FALSE) AS in_service,
      NULL::text AS cruise_type,
      NULL::text AS service_start,
      NULL::text AS service_end,
      4::int     AS tier
    FROM ships s
    WHERE s.is_river_cruise_ship = FALSE
      AND s.mmsi IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM voyages v
        JOIN prints p ON p.voyage_id = v.id
        WHERE v.ship_id = s.id
          AND v.is_deleted = FALSE
          AND v.visible_on_globe = TRUE
          AND v.start_date > DATE '2015-01-01'
          AND p.is_deleted = FALSE
          AND p.is_cruise_globe = TRUE
      )
    ORDER BY display_name ASC NULLS LAST, s.id ASC
  `);
  return result.rows;
}

// Voyage cells: per (mmsi, calendar day), counts voyages covering that day.
// SQL aggregation stays MMSI-keyed because that's the historically tuned
// query plan and ship_id grouping was hitting statement_timeout. The
// builder fans each MMSI bucket out to every ship_id sharing the MMSI,
// attributing by service window — same pattern used for silver cells.
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
      -- Categories are mutually exclusive in priority order so v + na + dw + need_process = t.
      -- Precedence: no-AIS > details-wrong > visible > need-process. A voyage
      -- counts as "no AIS" only when ALL its prints are deleted (i.e. no
      -- undeleted print survives). A voyage with at least one undeleted print
      -- and a route file is still visible to customers, so it stays green.
      SELECT
        s.mmsi,
        d::date AS day,
        COUNT(*)::int AS t,
        COUNT(*) FILTER (
          WHERE NOT (
                v.route_file_location IS NULL
             OR v.globe_customer_notification = 'No data available'
             OR NOT EXISTS (SELECT 1 FROM prints p WHERE p.voyage_id = v.id AND p.is_deleted = FALSE)
          )
          AND NOT (v.globe_customer_notification = 'Details are wrong')
          AND v.visible_on_globe = TRUE
        )::int AS v,
        COUNT(*) FILTER (
          WHERE v.route_file_location IS NULL
             OR v.globe_customer_notification = 'No data available'
             OR NOT EXISTS (
               SELECT 1 FROM prints p
               WHERE p.voyage_id = v.id AND p.is_deleted = FALSE
             )
        )::int AS na,
        COUNT(*) FILTER (
          WHERE NOT (
                v.route_file_location IS NULL
             OR v.globe_customer_notification = 'No data available'
             OR NOT EXISTS (SELECT 1 FROM prints p WHERE p.voyage_id = v.id AND p.is_deleted = FALSE)
          )
          AND v.globe_customer_notification = 'Details are wrong'
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
      COALESCE(ass.overland_count, 0)::int       AS ol,
      -- u = 1 when a human (not data-platform) has modified the row.
      -- ais_silver_summary has no created_at column, so we rely on updated_by
      -- alone — data-platform tags every row it inserts, so anything else
      -- means a human touched it.
      (CASE
        WHEN ass.updated_by IS NOT NULL
         AND ass.updated_by NOT IN ('data-platform')
        THEN 1 ELSE 0
      END)::int AS u,
      (CASE
        WHEN ass.updated_by IS NOT NULL
         AND ass.updated_by NOT IN ('data-platform')
        THEN ass.updated_by ELSE NULL
      END) AS updated_by
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
