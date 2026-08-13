/* eslint-disable no-console */
// Correct stale vessel names in the ship_metadata sheet.
//
// UNIVERSE: non-river ships that are NOT hidden from the globe
// (ships.visible_on_globe IS NOT FALSE), have an MMSI, and have an undeleted
// voyage ending since 2015-01-01. Matches probe-metadata-identity and
// append-missing-ships.
//
// SCOPE — deliberately narrow. A row is corrected only when:
//   1. its (mmsi, ship_name) matches NO ship row in the DB, and
//   2. its MMSI resolves to EXACTLY ONE ship row, and
//   3. writing that ship's name would not duplicate an (mmsi, ship_name)
//      pair the sheet already has.
// This is the `rename-unique` class from scripts/probe-metadata-identity.ts.
//
// WHAT IT NEVER TOUCHES: only A{row}:B{row} (ship_name, cruise_line) is ever
// in a written range. mmsi, cruise_type, service_start, service_end, tier and
// imo_number are never written — the curated service window is safe by
// construction, not by care.
//
// WHY rule 3 matters: a hull that was renamed legitimately has TWO sheet rows,
// one per era (e.g. "THOMSON DESTINY [2005-2012] - Thomson Cruises" AND
// "CELESTYAL OLYMPIA - Celestyal Cruises"), each with its own curated window.
// Renaming the older row would collide with the newer one, and the loader in
// lib/sheets/ship-metadata.ts dedupes by (mmsi, ship_name) — so one row's
// service window would be silently dropped. Those rows are correct as they
// stand and this script leaves them alone.
//
// Per .claude/rules/data-privacy.md, share only counts with AI. The per-row
// diff goes to tmp/, which is gitignored.
//
// Usage:
//   npm run sheet:fix-names           # dry run: counts + writes the diff file
//   npm run sheet:fix-names -- apply  # write columns A:B for the matched rows

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { Pool } from "pg";

const TAB = "ship_metadata";
const VOYAGE_START = "2015-01-01";
const OUT_FILE = path.join("tmp", "metadata-name-fixes.tsv");

// Refuse to bulk-rename. The probe measured 11 candidates; a sudden jump means
// the DB universe or the sheet changed shape and the classification should be
// re-checked before writing anything.
const MAX_RENAMES = 25;

const EXPECTED_HEADER = [
  "ship_name",
  "cruise_line",
  "mmsi",
  "cruise_type",
  "service_start",
  "service_end",
  "tier",
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

type DbShip = { ship_id: number; mmsi: number; ship_name: string; cruise_line: string };

// Same universe as probe-metadata-identity: non-river ships with an MMSI and at
// least one undeleted voyage ending since VOYAGE_START.
async function fetchDbShips(pool: Pool): Promise<DbShip[]> {
  const res = await pool.query<DbShip>(
    `
    SELECT
      s.id::int                                   AS ship_id,
      s.mmsi::int                                 AS mmsi,
      COALESCE(s.display_name, s.name, '')::text  AS ship_name,
      COALESCE(s.cruise_line, '')::text           AS cruise_line
    FROM ships s
    WHERE s.is_river_cruise_ship = FALSE
      AND s.mmsi IS NOT NULL
      -- Hidden ships are not rename targets. IS NOT FALSE, not = TRUE: a NULL
      -- here means "not marked hidden".
      AND s.visible_on_globe IS NOT FALSE
      AND EXISTS (
        SELECT 1 FROM voyages v
        WHERE v.ship_id = s.id
          AND v.is_deleted = FALSE
          AND v.start_date IS NOT NULL
          AND v.end_date IS NOT NULL
          AND v.end_date >= $1::date
      )
    ORDER BY s.mmsi, s.id
  `,
    [VOYAGE_START],
  );
  return res.rows;
}

export type Rename = {
  rowNum: number;
  mmsi: number;
  tier: string;
  oldName: string;
  newName: string;
  oldLine: string;
  newLine: string;
  shipId: number;
};

export type Plan = {
  renames: Rename[];
  skippedMatched: number;   // name already correct
  skippedAmbiguous: number; // >1 candidate on the MMSI
  skippedOrphan: number;    // no candidate at all
  skippedCollision: number; // target name already in the sheet
};

// Pure: decides which sheet rows get a new name. `raw` is the sheet including
// its header row, so rowNum is the 1-indexed spreadsheet row.
export function planRenames(raw: string[][], dbShips: DbShip[]): Plan {
  const byMmsi = new Map<number, DbShip[]>();
  const byMmsiName = new Set<string>();
  for (const s of dbShips) {
    const arr = byMmsi.get(s.mmsi) ?? [];
    arr.push(s);
    byMmsi.set(s.mmsi, arr);
    byMmsiName.add(vesselKey(s.mmsi, s.ship_name));
  }

  // Every (mmsi, name) the sheet currently occupies — the collision guard.
  const sheetKeys = new Set<string>();
  for (let i = 1; i < raw.length; i++) {
    const name = (raw[i]?.[0] ?? "").trim();
    const mmsiStr = (raw[i]?.[2] ?? "").trim();
    if (!name || !mmsiStr) continue;
    const mmsi = Number(mmsiStr);
    if (Number.isInteger(mmsi) && mmsi > 0) sheetKeys.add(vesselKey(mmsi, name));
  }

  const plan: Plan = { renames: [], skippedMatched: 0, skippedAmbiguous: 0, skippedOrphan: 0, skippedCollision: 0 };

  for (let i = 1; i < raw.length; i++) {
    const r = raw[i] ?? [];
    const name = (r[0] ?? "").trim();
    const line = (r[1] ?? "").trim();
    const mmsiStr = (r[2] ?? "").trim();
    const tier = (r[6] ?? "").trim();
    if (!mmsiStr) continue;
    const mmsi = Number(mmsiStr);
    if (!Number.isInteger(mmsi) || mmsi <= 0) continue;

    if (byMmsiName.has(vesselKey(mmsi, name))) { plan.skippedMatched++; continue; }

    const candidates = byMmsi.get(mmsi) ?? [];
    if (candidates.length === 0) { plan.skippedOrphan++; continue; }
    if (candidates.length > 1) { plan.skippedAmbiguous++; continue; }

    const t = candidates[0];
    const newName = safe(t.ship_name);
    if (!newName) { plan.skippedAmbiguous++; continue; }
    if (sheetKeys.has(vesselKey(mmsi, newName))) { plan.skippedCollision++; continue; }

    // Claim the target name so a second stale row on the same MMSI can't be
    // renamed to it as well — that would create the duplicate (mmsi, ship_name)
    // pair this guard exists to prevent, just via two planned writes instead of
    // one write against an existing row.
    sheetKeys.add(vesselKey(mmsi, newName));

    plan.renames.push({
      rowNum: i + 1,
      mmsi,
      tier,
      oldName: name,
      newName,
      oldLine: line,
      newLine: safe(t.cruise_line),
      shipId: t.ship_id,
    });
  }

  return plan;
}

async function main() {
  const apply = process.argv.includes("apply");
  console.log(`[fix-metadata-names] mode=${apply ? "APPLY" : "dry-run"}`);

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
    console.log(`[fix-metadata-names] DB ship rows in universe: ${dbShips.length}`);

    const { sheets, spreadsheetId } = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A1:H` });
    const raw = (res.data.values ?? []) as string[][];
    if (raw.length === 0) throw new Error(`${TAB} tab is empty`);

    // Header guard: if the columns aren't where we think, the A:B write would
    // land on the wrong fields. Abort rather than guess.
    const header = raw[0];
    for (let i = 0; i < EXPECTED_HEADER.length; i++) {
      const got = (header[i] ?? "").trim();
      if (got !== EXPECTED_HEADER[i]) {
        throw new Error(`${TAB} header mismatch at column ${String.fromCharCode(65 + i)}: got ${JSON.stringify(got)}, want ${JSON.stringify(EXPECTED_HEADER[i])}`);
      }
    }

    const { renames, skippedMatched, skippedAmbiguous, skippedOrphan, skippedCollision } = planRenames(raw, dbShips);

    const t12 = renames.filter((r) => r.tier === "1" || r.tier === "2").length;
    console.log("");
    console.log(`  rows to rename                 : ${renames.length} (T1+T2: ${t12})`);
    console.log(`  skipped — name already correct : ${skippedMatched}`);
    console.log(`  skipped — several candidates   : ${skippedAmbiguous}`);
    console.log(`  skipped — no candidate on MMSI : ${skippedOrphan}`);
    console.log(`  skipped — would collide        : ${skippedCollision}`);

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(
      OUT_FILE,
      [
        ["sheet_row", "mmsi", "tier", "old_ship_name", "new_ship_name", "old_cruise_line", "new_cruise_line", "ship_id"].join("\t"),
        ...renames.map((r) =>
          [r.rowNum, r.mmsi, r.tier, r.oldName, r.newName, r.oldLine, r.newLine, r.shipId].join("\t"),
        ),
      ].join("\n") + "\n",
      "utf8",
    );
    console.log(`  diff written to ${OUT_FILE} — review it before applying`);

    if (renames.length === 0) {
      console.log("[fix-metadata-names] nothing to do");
      return;
    }
    if (renames.length > MAX_RENAMES) {
      throw new Error(
        `${renames.length} renames exceeds the MAX_RENAMES guard of ${MAX_RENAMES}. ` +
        `Re-run npm run probe:metadata-identity and confirm the classification before raising this.`,
      );
    }

    if (!apply) {
      console.log(`[fix-metadata-names] dry run — re-run with 'apply' to write ${renames.length} rows`);
      return;
    }

    // Only A:B per affected row. Columns C–H are never in a written range.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: renames.map((r) => ({
          range: `${TAB}!A${r.rowNum}:B${r.rowNum}`,
          values: [[r.newName, r.newLine]],
        })),
      },
    });
    console.log(`[fix-metadata-names] wrote ${renames.length} rows (columns A:B only)`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[fix-metadata-names] failed", err);
  process.exitCode = 1;
});
