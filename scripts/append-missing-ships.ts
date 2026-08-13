/* eslint-disable no-console */
// Append ships that are missing from the ship_metadata tab.
//
// UNIVERSE: every non-river ship that is NOT hidden from the globe
// (ships.visible_on_globe IS NOT FALSE), has an MMSI, and has at least one
// undeleted voyage ending since 2015-01-01 — the same set
// scripts/probe-metadata-identity.ts measures. A ship is "missing" when its
// (mmsi, ship_name) pair has no row in the sheet.
//
// NEW ROWS ARE DELIBERATELY UNCURATED:
//   tier          = 4   (keeps them out of gap-cruises, which reads T1+T2)
//   cruise_type   = blank
//   service_start = blank
//   service_end   = blank
//   imo_number    = backfilled from Postgres (a fact, not a judgment)
//
// Why blank windows: a window seeded from the ship's voyage span is derived
// from the very data whose holes we hunt, so a ship missing a year of voyages
// would get a window that HIDES that gap. Blank gives a wide denominator that
// looks bad and gets noticed. Fail visible.
//
// EXISTING ROWS ARE NEVER TOUCHED. This script only appends.
//
// ORDERING: run `npm run sheet:fix-names` first. A row with a stale name looks
// "missing" under the ship's current name, so appending first would create a
// duplicate vessel. This script refuses to apply while rename candidates are
// outstanding.
//
// Per .claude/rules/data-privacy.md, share only counts with AI. The preview
// goes to tmp/, which is gitignored.
//
// Usage:
//   npm run sheet:append-missing           # dry run: counts + preview file
//   npm run sheet:append-missing -- apply  # append the rows

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { Pool } from "pg";

const TAB = "ship_metadata";
const VOYAGE_START = "2015-01-01";
const OUT_FILE = path.join("tmp", "metadata-append-preview.tsv");
const NEW_ROW_TIER = "4";

// Expected ~100 additions. A large jump means the universe changed shape and
// should be re-checked before writing.
const MAX_APPENDS = 300;

const EXPECTED_HEADER = [
  "ship_name",
  "cruise_line",
  "mmsi",
  "cruise_type",
  "service_start",
  "service_end",
  "tier",
  "imo_number",
] as const;

function getEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} env var not set`);
  return v;
}

function getSheets() {
  const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")
    .replace(/\\n/g, "\n")
    .replace(/^"|"$/g, "");
  const spreadsheetId = getEnv("GOOGLE_SHEETS_ID");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
}

// Same normalisation as lib/sheets/ship-metadata.ts vesselKey — keep in sync.
function vesselKey(mmsi: number, shipName: string): string {
  return `${mmsi}|${shipName.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

const safe = (v: string) => v.replace(/[\r\n\t]+/g, " ").trim();

export type DbShip = {
  ship_id: number;
  mmsi: number;
  imo: string;
  ship_name: string;
  cruise_line: string;
  globe_qualifying: boolean;
};

// Prints are pre-aggregated rather than checked with a correlated EXISTS per
// voyage — the correlated form is what timed out the snapshot query.
async function fetchDbShips(pool: Pool): Promise<DbShip[]> {
  const res = await pool.query<DbShip>(
    `
    WITH vp AS (
      SELECT p.voyage_id
      FROM prints p
      WHERE p.is_deleted = FALSE AND p.is_cruise_globe = TRUE
      GROUP BY p.voyage_id
    ),
    vs AS (
      SELECT
        v.ship_id,
        COUNT(*) FILTER (
          WHERE v.visible_on_globe = TRUE
            AND v.start_date > $1::date
            AND vp.voyage_id IS NOT NULL
        ) > 0 AS globe_qualifying
      FROM voyages v
      LEFT JOIN vp ON vp.voyage_id = v.id
      WHERE v.is_deleted = FALSE
        AND v.start_date IS NOT NULL
        AND v.end_date IS NOT NULL
        AND v.end_date >= $1::date
      GROUP BY v.ship_id
    )
    SELECT
      s.id::int                                   AS ship_id,
      s.mmsi::int                                 AS mmsi,
      COALESCE(s.imo_number::text, '')::text      AS imo,
      COALESCE(s.display_name, s.name, '')::text  AS ship_name,
      COALESCE(s.cruise_line, '')::text           AS cruise_line,
      vs.globe_qualifying
    FROM ships s
    JOIN vs ON vs.ship_id = s.id
    WHERE s.is_river_cruise_ship = FALSE
      AND s.mmsi IS NOT NULL
      -- Hidden ships never reach the globe, so they must not reach the sheet.
      -- IS NOT FALSE, not = TRUE: a NULL here means "not marked hidden".
      AND s.visible_on_globe IS NOT FALSE
    ORDER BY s.mmsi, s.id
  `,
    [VOYAGE_START],
  );
  return res.rows;
}

export type Plan = {
  missing: DbShip[];
  presentInSheet: number;
  dbDuplicates: number;    // same (mmsi, name) twice in the DB
  namelessDbRows: number;
  pendingRenames: number;  // stale sheet rows that must be fixed first
  blockedRenames: number;  // stale rows fix-names cannot fix (target name already in the sheet)
};

// Pure: decides which DB ships need a new sheet row. `raw` includes the header.
export function planAppends(raw: string[][], dbShips: DbShip[]): Plan {
  const sheetKeys = new Set<string>();
  const sheetRows: { mmsi: number; name: string }[] = [];
  for (let i = 1; i < raw.length; i++) {
    const name = (raw[i]?.[0] ?? "").trim();
    const mmsiStr = (raw[i]?.[2] ?? "").trim();
    if (!name || !mmsiStr) continue;
    const mmsi = Number(mmsiStr);
    if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
    sheetKeys.add(vesselKey(mmsi, name));
    sheetRows.push({ mmsi, name });
  }

  const dbKeys = new Set<string>();
  const byMmsi = new Map<number, DbShip[]>();
  for (const s of dbShips) {
    if (!safe(s.ship_name)) continue;
    dbKeys.add(vesselKey(s.mmsi, s.ship_name));
    const arr = byMmsi.get(s.mmsi) ?? [];
    arr.push(s);
    byMmsi.set(s.mmsi, arr);
  }

  // A sheet row whose name matches nothing in the DB while its MMSI resolves
  // to exactly one ship is a rename waiting to happen (see fix-metadata-names).
  // Appending before that is fixed would duplicate the vessel.
  //
  // ...unless the target name is ALREADY in the sheet. fix-names skips those
  // (renaming would duplicate the (mmsi, ship_name) key the loader dedupes on),
  // so treating them as pending would deadlock the two scripts against each
  // other. They are also harmless here: the vessel already has a row, so it is
  // not missing and cannot be appended twice. Counted separately, not blocking.
  let pendingRenames = 0;
  let blockedRenames = 0;
  for (const r of sheetRows) {
    if (dbKeys.has(vesselKey(r.mmsi, r.name))) continue;
    const candidates = byMmsi.get(r.mmsi) ?? [];
    if (candidates.length !== 1) continue;
    const target = safe(candidates[0].ship_name);
    if (!target) continue;
    if (sheetKeys.has(vesselKey(r.mmsi, target))) blockedRenames++;
    else pendingRenames++;
  }

  const plan: Plan = { missing: [], presentInSheet: 0, dbDuplicates: 0, namelessDbRows: 0, pendingRenames, blockedRenames };
  const seen = new Set<string>();
  for (const s of dbShips) {
    const name = safe(s.ship_name);
    if (!name) { plan.namelessDbRows++; continue; }
    const k = vesselKey(s.mmsi, name);
    if (seen.has(k)) { plan.dbDuplicates++; continue; }
    seen.add(k);
    if (sheetKeys.has(k)) { plan.presentInSheet++; continue; }
    plan.missing.push(s);
  }
  return plan;
}

async function main() {
  const apply = process.argv.includes("apply");
  console.log(`[append-missing-ships] mode=${apply ? "APPLY" : "dry-run"}`);

  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    max: 2,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    const dbShips = await fetchDbShips(pool);
    console.log(`[append-missing-ships] DB ship rows in universe: ${dbShips.length}`);

    const { sheets, spreadsheetId } = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A1:H` });
    const raw = (res.data.values ?? []) as string[][];
    if (raw.length === 0) throw new Error(`${TAB} tab is empty`);

    // Header guard: appended rows are positional, so a shifted column would
    // write an IMO into a service-date cell. Abort rather than guess.
    const header = raw[0];
    for (let i = 0; i < EXPECTED_HEADER.length; i++) {
      const got = (header[i] ?? "").trim();
      if (got !== EXPECTED_HEADER[i]) {
        throw new Error(`${TAB} header mismatch at column ${String.fromCharCode(65 + i)}: got ${JSON.stringify(got)}, want ${JSON.stringify(EXPECTED_HEADER[i])}`);
      }
    }
    console.log(`[append-missing-ships] sheet data rows: ${Math.max(0, raw.length - 1)}`);

    const plan = planAppends(raw, dbShips);
    const globeQualifying = plan.missing.filter((s) => s.globe_qualifying).length;
    const withImo = plan.missing.filter((s) => s.imo).length;

    console.log("");
    console.log(`  rows to append                 : ${plan.missing.length}`);
    console.log(`    ...globe-qualifying          : ${globeQualifying}`);
    console.log(`    ...voyages but no globe print: ${plan.missing.length - globeQualifying}`);
    console.log(`    ...carrying an imo_number    : ${withImo}`);
    console.log(`  already in the sheet           : ${plan.presentInSheet}`);
    console.log(`  DB rows sharing (mmsi, name)   : ${plan.dbDuplicates}`);
    console.log(`  DB rows with no name           : ${plan.namelessDbRows}`);
    console.log(`  outstanding renames            : ${plan.pendingRenames}`);
    console.log(`  stale rows fix-names can't fix : ${plan.blockedRenames} (target name already in the sheet — merge, needs a human)`);

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(
      OUT_FILE,
      [
        ["ship_name", "cruise_line", "mmsi", "tier", "imo_number", "ship_id", "globe_qualifying"].join("\t"),
        ...plan.missing.map((s) =>
          [safe(s.ship_name), safe(s.cruise_line), s.mmsi, NEW_ROW_TIER, s.imo, s.ship_id, s.globe_qualifying ? "yes" : "no"].join("\t"),
        ),
      ].join("\n") + "\n",
      "utf8",
    );
    console.log(`  preview written to ${OUT_FILE} — review it before applying`);

    if (plan.missing.length === 0) {
      console.log("[append-missing-ships] nothing to do");
      return;
    }
    if (plan.pendingRenames > 0) {
      throw new Error(
        `${plan.pendingRenames} sheet rows still carry a stale name. Run 'npm run sheet:fix-names -- apply' first, ` +
        `otherwise those vessels get appended a second time under their current name.`,
      );
    }
    if (plan.missing.length > MAX_APPENDS) {
      throw new Error(
        `${plan.missing.length} appends exceeds the MAX_APPENDS guard of ${MAX_APPENDS}. ` +
        `Re-run npm run probe:metadata-identity and confirm the universe before raising this.`,
      );
    }

    if (!apply) {
      console.log(`[append-missing-ships] dry run — re-run with 'apply' to append ${plan.missing.length} rows`);
      return;
    }

    // append always lands on fresh rows, so this cannot overwrite curated data.
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB}!A:H`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: plan.missing.map((s) => [
          safe(s.ship_name),
          safe(s.cruise_line),
          s.mmsi,
          "",              // cruise_type
          "",              // service_start
          "",              // service_end
          NEW_ROW_TIER,
          s.imo,
        ]),
      },
    });
    console.log(`[append-missing-ships] appended ${plan.missing.length} rows at tier ${NEW_ROW_TIER} with blank service windows`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[append-missing-ships] failed", err);
  process.exitCode = 1;
});
