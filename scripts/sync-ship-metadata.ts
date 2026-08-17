/* eslint-disable no-console */
// Sync the ship_metadata sheet against the DB while preserving the
// hand-curated columns D/E/F/G (cruise_type, service_start, service_end,
// tier). Three phases, in order:
//
//   1. REFRESH names — for every existing sheet row whose MMSI matches a
//      qualifying DB ship, rewrite column A (ship_name) and B (cruise_line)
//      to the current DB values. Fixes stale names (e.g. a hull renamed in
//      the DB but not in the sheet). Columns D–G are never written.
//
//   2. APPEND new — append a row for every qualifying (mmsi, ship_name) pair
//      not already in the sheet (after the refresh). New rows inherit
//      cruise_type/service window/tier from another row with the same MMSI
//      if one exists, else default to tier 4 / blank.
//
//   3. PRUNE — delete sheet rows whose (mmsi, ship_name) does NOT match any
//      qualifying DB ship. Because refresh runs first, curated rows whose
//      name merely drifted are corrected (not deleted); only genuinely
//      non-qualifying rows are removed. Header row is never touched.
//
// Qualifying ship = ships row with is_river_cruise_ship=FALSE, mmsi NOT NULL,
// and ≥1 voyage that is undeleted, visible_on_globe=TRUE, start_date>2015-01-01,
// with ≥1 undeleted print where is_cruise_globe=TRUE. (Same filter as
// fill-shared-mmsi.ts / prune-shared-mmsi.ts.)
//
// Per .claude/rules/data-privacy.md, share only counts/samples with AI.
//
// Usage:
//   npm run sheet:sync-metadata           # dry run: prints refresh/append/prune sets
//   npm run sheet:sync-metadata -- apply  # perform all three phases

import { google } from "googleapis";
import { Pool } from "pg";

const TAB = "ship_metadata";

function getEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} env var not set`);
  return v;
}

function getSheets() {
  const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n").replace(/^"|"$/g, "");
  const spreadsheetId = getEnv("GOOGLE_SHEETS_ID");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
}

type DbShip = { mmsi: number; ship_name: string; cruise_line: string };

async function fetchQualifyingShips(pool: Pool): Promise<DbShip[]> {
  const res = await pool.query<DbShip>(`
    SELECT
      s.mmsi::int AS mmsi,
      COALESCE(s.display_name, s.name, '')::text AS ship_name,
      COALESCE(s.cruise_line, '')::text          AS cruise_line
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
    ORDER BY s.mmsi, ship_name
  `);
  return res.rows;
}

const safe = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
const keyOf = (mmsi: number, name: string) => `${mmsi}|${name.trim().toLowerCase()}`;

async function main() {
  const apply = process.argv.includes("apply");
  console.log(`[sync-ship-metadata] mode=${apply ? "APPLY" : "dry-run"}`);

  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({ connectionString: url, max: 2, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    const dbShips = await fetchQualifyingShips(pool);
    console.log(`[sync-ship-metadata] qualifying DB ships: ${dbShips.length}`);

    // DB lookups
    // - byMmsiName: exact (mmsi, name) → {cruise_line} for refresh/append membership
    // - byMmsi: mmsi → list of qualifying ships (for "does this MMSI qualify at all")
    const dbByMmsiName = new Map<string, DbShip>();
    const dbByMmsi = new Map<number, DbShip[]>();
    for (const s of dbShips) {
      dbByMmsiName.set(keyOf(s.mmsi, s.ship_name), s);
      const arr = dbByMmsi.get(s.mmsi) ?? [];
      arr.push(s);
      dbByMmsi.set(s.mmsi, arr);
    }

    const { sheets, spreadsheetId } = getSheets();

    // Resolve sheetId (gid) for batch row deletes.
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
    const tab = meta.data.sheets?.find((s) => s.properties?.title === TAB);
    if (!tab?.properties || (tab.properties.sheetId == null)) throw new Error(`${TAB} tab not found`);
    const sheetId = tab.properties.sheetId;

    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A1:G` });
    const rows = (res.data.values ?? []) as string[][];
    console.log(`[sync-ship-metadata] sheet data rows: ${rows.length - 1}`);

    // ---- Phase 1: REFRESH names on existing rows (match by MMSI) ----
    // A sheet row's MMSI can map to multiple qualifying DB ships (shared
    // hull). We only auto-correct when there's exactly ONE qualifying ship
    // for that MMSI — otherwise we can't know which name belongs to which
    // row, so we leave it for manual review.
    type Update = { rowIdx: number; oldName: string; newName: string; oldLine: string; newLine: string };
    const refreshes: Update[] = [];
    const sheetMeta = new Map<number, { cruise_type: string; service_start: string; service_end: string; tier: string }>();
    const existingKeysAfterRefresh = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] ?? "").trim();
      const line = (r[1] ?? "").trim();
      const mmsiStr = (r[2] ?? "").trim();
      if (!mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;

      // Capture metadata per MMSI for inheritance on append.
      if (!sheetMeta.has(mmsi)) {
        sheetMeta.set(mmsi, {
          cruise_type: (r[3] ?? "").trim(),
          service_start: (r[4] ?? "").trim(),
          service_end: (r[5] ?? "").trim(),
          tier: (r[6] ?? "").trim() || "4",
        });
      }

      const candidates = dbByMmsi.get(mmsi) ?? [];
      let finalName = name;
      let finalLine = line;
      if (candidates.length === 1) {
        const db = candidates[0];
        if (safe(db.ship_name) !== name || safe(db.cruise_line) !== line) {
          refreshes.push({ rowIdx: i, oldName: name, newName: safe(db.ship_name), oldLine: line, newLine: safe(db.cruise_line) });
          finalName = safe(db.ship_name);
          finalLine = safe(db.cruise_line);
        }
      }
      // Record the post-refresh key so append doesn't re-add it.
      existingKeysAfterRefresh.add(keyOf(mmsi, finalName));
    }

    console.log(`[sync-ship-metadata] phase 1 — name/line refreshes: ${refreshes.length}`);
    for (const u of refreshes.slice(0, 10)) {
      console.log(`    row ${u.rowIdx + 1}: "${u.oldName}" → "${u.newName}"${u.oldLine !== u.newLine ? `  | line "${u.oldLine}" → "${u.newLine}"` : ""}`);
    }
    if (refreshes.length > 10) console.log(`    ... and ${refreshes.length - 10} more`);

    // ---- Phase 2: APPEND newly-qualifying ships ----
    const toAppend: (string | number)[][] = [];
    const appendSample: string[] = [];
    for (const s of dbShips) {
      const k = keyOf(s.mmsi, s.ship_name);
      if (existingKeysAfterRefresh.has(k)) continue;
      const inherit = sheetMeta.get(s.mmsi);
      toAppend.push([
        safe(s.ship_name),
        safe(s.cruise_line),
        s.mmsi,
        inherit?.cruise_type ?? "",
        inherit?.service_start ?? "",
        inherit?.service_end ?? "",
        inherit?.tier ?? "4",
      ]);
      appendSample.push(`${s.mmsi} ${s.ship_name}${inherit ? " (inherit meta)" : " (tier 4)"}`);
      existingKeysAfterRefresh.add(k);
    }
    console.log(`[sync-ship-metadata] phase 2 — rows to append: ${toAppend.length}`);
    for (const s of appendSample.slice(0, 10)) console.log(`    ${s}`);
    if (appendSample.length > 10) console.log(`    ... and ${appendSample.length - 10} more`);

    // ---- Phase 3: PRUNE rows whose (mmsi, name) doesn't qualify ----
    // Computed against the POST-refresh names: a row keeps the name we would
    // write in phase 1. Match against exact (mmsi, name) qualifying set.
    const toDelete: { rowNum: number; mmsi: number; name: string }[] = [];
    const refreshByRow = new Map<number, string>();
    for (const u of refreshes) refreshByRow.set(u.rowIdx, u.newName);
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const mmsiStr = (r[2] ?? "").trim();
      if (!mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
      const effectiveName = refreshByRow.get(i) ?? (r[0] ?? "").trim();
      if (!dbByMmsiName.has(keyOf(mmsi, effectiveName))) {
        toDelete.push({ rowNum: i + 1, mmsi, name: effectiveName });
      }
    }
    console.log(`[sync-ship-metadata] phase 3 — rows to prune: ${toDelete.length}`);
    for (const d of toDelete.slice(0, 20)) console.log(`    row ${d.rowNum} mmsi=${d.mmsi} ${d.name}`);
    if (toDelete.length > 20) console.log(`    ... and ${toDelete.length - 20} more`);

    if (!apply) {
      console.log(`[sync-ship-metadata] dry run — re-run with 'apply' to perform all three phases`);
      return;
    }

    // ===== APPLY =====
    // 1. Refresh: write A:B per affected row (one batch update with value ranges).
    if (refreshes.length > 0) {
      const data = refreshes.map((u) => ({
        range: `${TAB}!A${u.rowIdx + 1}:B${u.rowIdx + 1}`,
        values: [[u.newName, u.newLine]],
      }));
      // batchUpdate values endpoint, chunked.
      const CHUNK = 500;
      for (let i = 0; i < data.length; i += CHUNK) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: "USER_ENTERED", data: data.slice(i, i + CHUNK) },
        });
      }
      console.log(`[sync-ship-metadata] applied ${refreshes.length} name refreshes`);
    }

    // 2. Append new rows.
    if (toAppend.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${TAB}!A:G`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: toAppend },
      });
      console.log(`[sync-ship-metadata] appended ${toAppend.length} rows`);
    }

    // 3. Prune. Delete descending so row indices stay valid. NOTE: appended
    // rows landed at the bottom; their row numbers don't collide with the
    // original toDelete rowNums (which were computed before append). Since
    // we delete by original 1-indexed positions in descending order and the
    // appends are strictly below all of them, this is safe.
    if (toDelete.length > 0) {
      const sorted = [...toDelete].sort((a, b) => b.rowNum - a.rowNum);
      const requests = sorted.map((d) => ({
        deleteDimension: {
          range: { sheetId, dimension: "ROWS" as const, startIndex: d.rowNum - 1, endIndex: d.rowNum },
        },
      }));
      const CHUNK = 100;
      for (let i = 0; i < requests.length; i += CHUNK) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests.slice(i, i + CHUNK) } });
        console.log(`[sync-ship-metadata] deleted prune batch ${i / CHUNK + 1}`);
      }
      console.log(`[sync-ship-metadata] pruned ${toDelete.length} rows`);
    }

    console.log(`[sync-ship-metadata] done`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => { console.error("[sync-ship-metadata] failed", e); process.exitCode = 1; });
