/* eslint-disable no-console */
// Generate "gap cruises" for T1+T2 ships.
//
// Definitions (from product spec):
//   - gap day  = ship-day where NO visible-on-globe voyage covers it
//                (and ship is in service per ship_metadata.service_start/end)
//   - visible day = ship-day with ≥1 voyage where visible_on_globe = TRUE
//   - gap     = maximal continuous run of gap days for one ship
//   - anchor  = a visible day immediately/eventually before or after the gap.
//               For each gap, emit one row per (start_anchor, end_anchor)
//               pair across the gap. start_anchor contributes start_date and
//               start_port (= the anchor voyage's end port — i.e. where the
//               ship was last seen before the gap). end_anchor contributes
//               end_date and end_port (= the anchor voyage's start port).
//
// Scope:
//   - tier IN ('T1','T2') (from ship_metadata sheet)
//   - no max gap duration
//   - exclude days outside [service_start, service_end] window
//   - exclude river-cruise ships, exclude is_deleted voyages
//
// Output: rows written to the "voyage_gap" tab of GOOGLE_SHEETS_ID, columns:
//   Ship | ship_id | mmsi | start_port | start_port_id | end_port |
//   end_port_id | start_date | end_date | cruise_id
//   cruise_id = {ship_id}_{start_port_id}_{start_date}_{end_date}
//
// Per .claude/rules/data-privacy.md, do not paste this script's output back
// into AI chat — pass aggregate counts only.
//
// Usage:
//   npm run gap:cruises           # dry run: prints counts + first 5 sample rows + plan
//   npm run gap:cruises -- apply  # writes to voyage_gap tab (clears tab first, then appends)

import { google } from "googleapis";
import { Pool } from "pg";

console.log("[gap-cruises] script starting...");
console.log("[gap-cruises] imports loaded");

const VOYAGE_START = "2015-01-01";
const TAB_NAME = "voyage_gap";

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} env var not set`);
  return v;
}

function getSheetsClient() {
  const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")
    .replace(/\\n/g, "\n")
    .replace(/^"|"$/g, "");
  const spreadsheetId = getEnv("GOOGLE_SHEETS_ID");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId };
}

// Discover voyage port columns at runtime. The repo has no committed
// reference to ports, so we probe information_schema rather than guessing.
type PortCols = {
  startIdCol: string;
  endIdCol: string;
  portsTable: string;
  portIdCol: string;
  portNameCol: string;
};

async function discoverPortColumns(pool: Pool): Promise<PortCols> {
  const voyageCols = await pool.query<{ column_name: string; data_type: string }>(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='voyages'
    ORDER BY ordinal_position
  `);
  const names = voyageCols.rows.map((r) => r.column_name);
  const pickFK = (candidates: string[]): string => {
    for (const c of candidates) if (names.includes(c)) return c;
    throw new Error(`voyages: none of [${candidates.join(", ")}] found. Columns: ${names.join(", ")}`);
  };
  const startIdCol = pickFK([
    "start_port_id", "departure_port_id", "embark_port_id", "from_port_id", "origin_port_id",
  ]);
  const endIdCol = pickFK([
    "end_port_id", "arrival_port_id", "disembark_port_id", "to_port_id", "destination_port_id",
  ]);

  const portsTables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN ('ports','port')
  `);
  if (portsTables.rows.length === 0) throw new Error("no 'ports' or 'port' table found in public schema");
  const portsTable = portsTables.rows[0].table_name;

  const portCols = await pool.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [portsTable]);
  const portColNames = portCols.rows.map((r) => r.column_name);
  const portIdCol = portColNames.includes("id") ? "id" : portColNames.find((n) => n.endsWith("_id")) ?? "id";
  const portNameCol = ["name", "port_name", "display_name", "label"].find((n) => portColNames.includes(n))
    ?? (() => { throw new Error(`ports: no name column found. Columns: ${portColNames.join(", ")}`); })();

  return { startIdCol, endIdCol, portsTable, portIdCol, portNameCol };
}

type TierMeta = {
  tier: 1 | 2;
  serviceStart: string | null; // YYYY-MM-DD or null
  serviceEnd: string | null;
};

async function fetchT12Metadata(): Promise<Map<number, TierMeta>> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "ship_metadata!A1:G" });
  const rows = (res.data.values ?? []) as string[][];
  // Header in row 0: ship_name | cruise_line | mmsi | cruise_type | service_start | service_end | tier
  const out = new Map<number, TierMeta>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const mmsi = Number((r[2] ?? "").trim());
    const tierStr = (r[6] ?? "").trim();
    const tier = Number(tierStr);
    if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
    if (tier !== 1 && tier !== 2) continue;
    const ss = (r[4] ?? "").trim();
    const se = (r[5] ?? "").trim();
    // Keep the widest service window across rows sharing this mmsi.
    const prior = out.get(mmsi);
    const serviceStart = ss && /^\d{4}-\d{2}-\d{2}$/.test(ss) ? ss : null;
    const serviceEnd = se && /^\d{4}-\d{2}-\d{2}$/.test(se) ? se : null;
    if (!prior) {
      out.set(mmsi, { tier: tier as 1 | 2, serviceStart, serviceEnd });
    } else {
      out.set(mmsi, {
        tier: prior.tier, // first one wins; tier should be consistent per mmsi anyway
        serviceStart: minNullable(prior.serviceStart, serviceStart),
        serviceEnd: maxNullable(prior.serviceEnd, serviceEnd),
      });
    }
  }
  return out;
}

function minNullable(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
function maxNullable(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

type VoyageRow = {
  ship_id: number;
  ship_name: string;
  mmsi: number;
  voyage_id: number;
  start_date: string; // YYYY-MM-DD
  end_date: string;
  visible: boolean;
  start_port_id: number | null;
  start_port_name: string | null;
  end_port_id: number | null;
  end_port_name: string | null;
};

async function fetchVoyagesForMmsis(
  pool: Pool,
  mmsis: number[],
  cols: PortCols,
): Promise<VoyageRow[]> {
  if (mmsis.length === 0) return [];
  // "visible" matches the snapshot's 'v' count in lib/snapshot/queries.ts:
  //   visible_on_globe = TRUE
  //   AND route_file_location IS NOT NULL
  //   AND globe_customer_notification NOT IN ('No data available','Details are wrong')
  //   AND at least one print on this voyage has is_deleted = FALSE
  // This is the strict rule the heatmap uses to color a cell green.
  const sql = `
    SELECT
      s.id::int                                    AS ship_id,
      COALESCE(s.display_name, s.name, '')::text   AS ship_name,
      s.mmsi::int                                  AS mmsi,
      v.id::int                                    AS voyage_id,
      to_char(v.start_date, 'YYYY-MM-DD')          AS start_date,
      to_char(v.end_date, 'YYYY-MM-DD')            AS end_date,
      (
        v.visible_on_globe = TRUE
        AND v.route_file_location IS NOT NULL
        AND (v.globe_customer_notification IS NULL
             OR v.globe_customer_notification NOT IN ('No data available','Details are wrong'))
        AND EXISTS (
          SELECT 1 FROM prints p
          WHERE p.voyage_id = v.id AND p.is_deleted = FALSE
        )
      )                                            AS visible,
      sp.${cols.portIdCol}::int                    AS start_port_id,
      sp.${cols.portNameCol}::text                 AS start_port_name,
      ep.${cols.portIdCol}::int                    AS end_port_id,
      ep.${cols.portNameCol}::text                 AS end_port_name
    FROM voyages v
    JOIN ships s ON s.id = v.ship_id
    LEFT JOIN ${cols.portsTable} sp ON sp.${cols.portIdCol} = v.${cols.startIdCol}
    LEFT JOIN ${cols.portsTable} ep ON ep.${cols.portIdCol} = v.${cols.endIdCol}
    WHERE v.is_deleted = FALSE
      AND v.start_date IS NOT NULL
      AND v.end_date IS NOT NULL
      AND v.end_date >= $1::date
      AND v.start_date <= CURRENT_DATE
      AND s.is_river_cruise_ship = FALSE
      AND s.mmsi = ANY($2::bigint[])
    ORDER BY s.mmsi, v.start_date, v.end_date
  `;
  const res = await pool.query<VoyageRow>(sql, [VOYAGE_START, mmsis]);
  return res.rows;
}

// Compute the set of dates for a ship that are *visible* (covered by a
// visible_on_globe voyage). Returns sorted list of YYYY-MM-DD strings.
// Also returns a map date→{voyage start_port, end_port} for the anchor's
// owning voyage. When multiple voyages cover one day, pick the one with
// the latest start_date (the most-recently-begun voyage).
type VisibleDay = {
  date: string;
  start_port_id: number | null;
  start_port_name: string | null;
  end_port_id: number | null;
  end_port_name: string | null;
};

function dayIter(start: string, end: string, cb: (d: string) => void) {
  // both inclusive, strings YYYY-MM-DD, UTC-safe
  const s = new Date(start + "T00:00:00Z").getTime();
  const e = new Date(end + "T00:00:00Z").getTime();
  for (let t = s; t <= e; t += 86400000) {
    cb(new Date(t).toISOString().slice(0, 10));
  }
}

function buildVisibleDays(voyages: VoyageRow[], serviceStart: string | null, serviceEnd: string | null): VisibleDay[] {
  const byDate = new Map<string, { voyageStart: string; row: VoyageRow }>();
  for (const v of voyages) {
    if (!v.visible) continue;
    dayIter(v.start_date, v.end_date, (d) => {
      if (serviceStart && d < serviceStart) return;
      if (serviceEnd && d > serviceEnd) return;
      const prior = byDate.get(d);
      if (!prior || v.start_date > prior.voyageStart) {
        byDate.set(d, { voyageStart: v.start_date, row: v });
      }
    });
  }
  const out: VisibleDay[] = [];
  for (const [date, { row }] of byDate) {
    out.push({
      date,
      start_port_id: row.start_port_id,
      start_port_name: row.start_port_name,
      end_port_id: row.end_port_id,
      end_port_name: row.end_port_name,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Per-ship set of COVID-window dates the coverage adjustment removed from
// the denominator. Mirrors the logic in app/coverage/CoverageGrid.tsx so
// gap-cruises stay in sync with what users see on the heatmap.
const COVID_START = "2020-03-01";
const COVID_END   = "2021-11-30";

function buildCovidExcludedDates(visibleDays: VisibleDay[]): Set<string> {
  const visibleSet = new Set(visibleDays.map((d) => d.date));
  const excluded = new Set<string>();
  // Walk every day from COVID_START to COVID_END; find contiguous visible
  // runs ≥10 days anchored within 7 days of either boundary; those days
  // stay counted, all OTHER COVID days are excluded.
  const startMs = new Date(COVID_START + "T00:00:00Z").getTime();
  const endMs   = new Date(COVID_END   + "T00:00:00Z").getTime();
  const days: string[] = [];
  for (let t = startMs; t <= endMs; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }

  const qualifying = new Set<string>();
  let runStart = -1;
  const flush = (runEnd: number) => {
    if (runStart < 0) return;
    const len = runEnd - runStart + 1;
    const anchored = runStart <= 7 || (days.length - 1 - runEnd) <= 7;
    if (len >= 10 && anchored) {
      for (let k = runStart; k <= runEnd; k++) qualifying.add(days[k]);
    }
    runStart = -1;
  };
  for (let i = 0; i < days.length; i++) {
    if (visibleSet.has(days[i])) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i - 1);
    }
  }
  flush(days.length - 1);

  for (const d of days) {
    if (visibleSet.has(d)) continue; // visible day, not excluded (counted)
    if (qualifying.has(d)) continue; // part of qualifying run
    excluded.add(d);
  }
  return excluded;
}

type OutRow = {
  ship: string;
  ship_id: number;
  mmsi: number;
  start_port: string;
  start_port_id: string;
  end_port: string;
  end_port_id: string;
  start_date: string;
  end_date: string;
  cruise_id: string;
};

function buildGapRows(voyages: VoyageRow[], serviceStart: string | null, serviceEnd: string | null): OutRow[] {
  if (voyages.length === 0) return [];
  const ship_id = voyages[0].ship_id;
  const ship = voyages[0].ship_name;
  const mmsi = voyages[0].mmsi;

  const visibleDays = buildVisibleDays(voyages, serviceStart, serviceEnd);
  if (visibleDays.length < 2) return [];

  // COVID-window days the heatmap excluded from this ship's denominator
  // are also dropped from gap output — they don't represent missing
  // coverage that the team needs to fill.
  const covidExcluded = buildCovidExcludedDates(visibleDays);

  // A gap is a run of consecutive missing dates between two visible dates.
  // Each emitted row is a NIGHTS-night cruise: its end_date is the turnaround
  // day and is reused as the NEXT row's start_date, so consecutive rows chain
  // with no 1-day hole between them (a cruise disembarks and the next embarks
  // on the same day, as real itineraries do). The final row of a run ends on
  // the last gap day, so a run may be shorter than NIGHTS nights.
  // Each row uses the last-seen port (the start-anchor's end_port) as BOTH
  // start_port and end_port to avoid duplicate-looking start_date/different-
  // end_date rows. COVID-excluded days split a gap into independent runs.
  // Dedupe by (ship_id, start_date, end_date).
  const NIGHTS = 7;
  const dayAfter = (s: string) => new Date(new Date(s + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  const addDays = (s: string, n: number) =>
    new Date(new Date(s + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

  const out: OutRow[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < visibleDays.length - 1; i++) {
    const a = visibleDays[i];
    const b = visibleDays[i + 1];
    if (dayAfter(a.date) === b.date) continue;

    // Gap days: from a.date+1 to b.date-1 inclusive.
    const gapStart = dayAfter(a.date);
    const gapEnd = addDays(b.date, -1); // b.date itself is visible, not part of gap

    const emit = (start: string, end: string) => {
      const portId = a.end_port_id;
      const portName = a.end_port_name;
      const key = `${ship_id}|${start}|${end}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      out.push({
        ship,
        ship_id,
        mmsi,
        start_port: portName ?? "",
        start_port_id: portId !== null ? String(portId) : "",
        end_port: portName ?? "",
        end_port_id: portId !== null ? String(portId) : "",
        start_date: start,
        end_date: end,
        cruise_id: `${ship_id}_${portId ?? ""}_${start}_${end}`,
      });
    };

    // Walk the gap day-by-day, accumulating runs of consecutive
    // non-COVID-excluded days, then chain cruises across each run.
    let runStart: string | null = null;
    let runEnd: string | null = null;
    const flushRun = () => {
      if (runStart === null || runEnd === null) return;
      if (runStart === runEnd) {
        // Isolated single gap day — no nights to span, but still a real gap.
        emit(runStart, runEnd);
      } else {
        let cursor = runStart;
        while (cursor < runEnd) {
          const next = addDays(cursor, NIGHTS);
          const end = next < runEnd ? next : runEnd;
          emit(cursor, end);
          cursor = end;
        }
      }
      runStart = null;
      runEnd = null;
    };

    for (let cursor = gapStart; cursor <= gapEnd; cursor = addDays(cursor, 1)) {
      if (covidExcluded.has(cursor)) {
        flushRun();
        continue;
      }
      if (runStart === null) runStart = cursor;
      runEnd = cursor;
    }
    flushRun();
  }

  return out;
}

async function writeToSheet(rows: OutRow[]): Promise<void> {
  const { sheets, spreadsheetId } = getSheetsClient();
  // Clear existing content (header + data) then write fresh.
  console.log(`[gap-cruises] clearing ${TAB_NAME} tab...`);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${TAB_NAME}!A:J` });

  const header = [
    "Ship", "ship_id", "mmsi",
    "start_port", "start_port_id",
    "end_port", "end_port_id",
    "start_date", "end_date",
    "cruise_id",
  ];

  // Write the header first, then append data in batches. A single update with
  // tens of thousands of rows can exceed the request size limit and hang on
  // retry; batched appends keep each request small and let us log progress.
  console.log(`[gap-cruises] writing header...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [header] },
  });

  const BATCH = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = slice.map((r) => [
      r.ship, r.ship_id, r.mmsi,
      r.start_port, r.start_port_id,
      r.end_port, r.end_port_id,
      r.start_date, r.end_date,
      r.cruise_id,
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_NAME}!A:J`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
    console.log(`[gap-cruises]   appended rows ${i + 1}–${Math.min(i + BATCH, rows.length)} of ${rows.length}`);
  }
}

async function main() {
  console.log(`[gap-cruises] main() entered`);
  const apply = process.argv.includes("apply");
  console.log(`[gap-cruises] mode=${apply ? "APPLY" : "dry-run"}`);

  const url = getEnv("DATABASE_URL");
  console.log(`[gap-cruises] DATABASE_URL loaded (length=${url.length})`);
  // Mask password but show host so we know which DB we're hitting
  const masked = url.replace(/:[^@/]+@/, ":***@");
  console.log(`[gap-cruises] DB target: ${masked}`);
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    max: 2,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  console.log(`[gap-cruises] testing DB connection (10s timeout)...`);
  await pool.query("SELECT 1");
  console.log(`[gap-cruises] DB connection OK`);

  try {
    console.log(`[gap-cruises] step 1/4: reading ship_metadata sheet...`);
    const tierByMmsi = await fetchT12Metadata();
    console.log(`[gap-cruises]   T1+T2 ships in sheet: ${tierByMmsi.size}`);

    console.log(`[gap-cruises] step 2/4: probing voyages/ports schema via information_schema...`);
    const cols = await discoverPortColumns(pool);
    console.log(`[gap-cruises]   discovered: voyages.${cols.startIdCol} / voyages.${cols.endIdCol} → ${cols.portsTable}(${cols.portIdCol}, ${cols.portNameCol})`);

    const mmsis = Array.from(tierByMmsi.keys());
    console.log(`[gap-cruises] step 3/4: fetching voyages for ${mmsis.length} MMSIs (may take 30-60s)...`);
    const t0 = Date.now();
    const voyages = await fetchVoyagesForMmsis(pool, mmsis, cols);
    console.log(`[gap-cruises]   voyages loaded: ${voyages.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    console.log(`[gap-cruises] step 4/4: computing gaps...`);

    // Group voyages by mmsi (one ship row per unique mmsi; multiple ship_ids
    // may share an mmsi — we treat them as one timeline since AIS history is
    // per-hull. ship_id reported is the lexicographically-first ship_name's.)
    const byMmsi = new Map<number, VoyageRow[]>();
    for (const v of voyages) {
      let arr = byMmsi.get(v.mmsi);
      if (!arr) { arr = []; byMmsi.set(v.mmsi, arr); }
      arr.push(v);
    }

    const allRows: OutRow[] = [];
    let shipsWithGaps = 0;
    for (const [mmsi, vs] of byMmsi) {
      const meta = tierByMmsi.get(mmsi);
      if (!meta) continue;
      const rows = buildGapRows(vs, meta.serviceStart, meta.serviceEnd);
      if (rows.length > 0) shipsWithGaps++;
      for (const r of rows) allRows.push(r);
    }

    console.log(`[gap-cruises] gap-cruise rows: ${allRows.length} across ${shipsWithGaps} ships`);
    // Tier breakdown
    const t1Rows = allRows.filter((r) => tierByMmsi.get(r.mmsi)?.tier === 1).length;
    const t2Rows = allRows.length - t1Rows;
    console.log(`[gap-cruises]   T1 rows: ${t1Rows}`);
    console.log(`[gap-cruises]   T2 rows: ${t2Rows}`);

    if (allRows.length > 0) {
      console.log(`[gap-cruises] sample (first 5):`);
      for (const r of allRows.slice(0, 5)) {
        console.log(`    ${r.ship}\t${r.ship_id}\t${r.mmsi}\t${r.start_port}\t${r.start_port_id}\t${r.end_port}\t${r.end_port_id}\t${r.start_date}\t${r.end_date}\t${r.cruise_id}`);
      }
    }

    if (!apply) {
      console.log(`[gap-cruises] dry run — re-run with 'apply' to write ${allRows.length} rows to "${TAB_NAME}" tab`);
      return;
    }

    await writeToSheet(allRows);
    console.log(`[gap-cruises] wrote ${allRows.length} rows + header to "${TAB_NAME}" tab`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[gap-cruises] failed", err);
  process.exitCode = 1;
});
