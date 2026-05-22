/* eslint-disable no-console */
// Destructive: deletes ship_metadata sheet rows that do NOT meet the
// stricter cruise-globe + post-2015 + visible_on_globe filter.
//
// Qualifying ship = ships row with is_river_cruise_ship=FALSE, mmsi NOT NULL,
// AND at least one voyage that is:
//   - is_deleted = FALSE
//   - visible_on_globe = TRUE
//   - start_date > 2015-01-01
//   - has at least one print where is_deleted = FALSE AND is_cruise_globe = TRUE
//
// Sheet rows whose (mmsi, ship_name) doesn't match a qualifying ship are
// deleted. Header row (row 1) is never touched.
//
// Usage:
//   npm run sheet:prune-shared-mmsi          # dry run, prints what would go
//   npm run sheet:prune-shared-mmsi -- apply # actually delete

import { google } from "googleapis";
import { Pool } from "pg";

function getEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`${k} env var not set`); return v; }

async function main() {
  const apply = process.argv.includes("apply");
  console.log(`[prune-shared-mmsi] mode=${apply ? "APPLY (DESTRUCTIVE)" : "dry-run"}`);

  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({ connectionString: url, max: 2, ssl: isLocal ? false : { rejectUnauthorized: false } });

  try {
    const dbResult = await pool.query<{ mmsi: number; ship_name: string }>(`
      SELECT
        s.mmsi::int AS mmsi,
        COALESCE(s.display_name, s.name, '')::text AS ship_name
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
    `);
    const qualifying = new Set<string>();
    for (const r of dbResult.rows) {
      qualifying.add(`${r.mmsi}|${r.ship_name.trim().toLowerCase()}`);
    }
    console.log(`[prune-shared-mmsi] qualifying ships in DB: ${dbResult.rows.length}`);

    const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    const privateKey = getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n").replace(/^"|"$/g, "");
    const spreadsheetId = getEnv("GOOGLE_SHEETS_ID");
    const auth = new google.auth.GoogleAuth({ credentials: { client_email: email, private_key: privateKey }, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });

    // Resolve the ship_metadata tab's sheetId (gid) — required by batchUpdate.
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
    const tab = meta.data.sheets?.find((s) => s.properties?.title === "ship_metadata");
    if (!tab?.properties?.sheetId && tab?.properties?.sheetId !== 0) {
      throw new Error("ship_metadata tab not found");
    }
    const sheetId = tab.properties.sheetId;
    console.log(`[prune-shared-mmsi] ship_metadata sheetId=${sheetId}`);

    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "ship_metadata!A1:G" });
    const rows = (res.data.values ?? []) as string[][];
    console.log(`[prune-shared-mmsi] sheet data rows: ${rows.length - 1}`);

    const toDelete: { rowNum: number; mmsi: number; name: string }[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] ?? "").trim();
      const mmsiStr = (r[2] ?? "").trim();
      if (!mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
      const key = `${mmsi}|${name.toLowerCase()}`;
      if (!qualifying.has(key)) {
        // i is 0-indexed in the array; rowNum is 1-indexed for human display.
        toDelete.push({ rowNum: i + 1, mmsi, name });
      }
    }

    console.log(`[prune-shared-mmsi] rows to delete: ${toDelete.length}`);
    if (toDelete.length > 0) {
      console.log(`[prune-shared-mmsi] first 20:`);
      for (const r of toDelete.slice(0, 20)) console.log(`    row=${r.rowNum} mmsi=${r.mmsi} ${r.name}`);
      if (toDelete.length > 20) console.log(`    ... and ${toDelete.length - 20} more`);
    }

    if (toDelete.length === 0) {
      console.log(`[prune-shared-mmsi] nothing to do`);
      return;
    }

    if (!apply) {
      console.log(`[prune-shared-mmsi] dry run — re-run with 'apply' to actually delete`);
      return;
    }

    // Build deleteDimension requests. rowNum is 1-indexed (1 = header).
    // batchUpdate startIndex is 0-indexed; to delete sheet row N we use
    // startIndex = N - 1, endIndex = N. Sort descending so each delete
    // doesn't shift indices of pending deletes.
    const sorted = [...toDelete].sort((a, b) => b.rowNum - a.rowNum);
    const requests = sorted.map((r) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS" as const,
          startIndex: r.rowNum - 1,
          endIndex: r.rowNum,
        },
      },
    }));

    // Chunk to keep individual batchUpdate payloads reasonable.
    const CHUNK = 100;
    for (let i = 0; i < requests.length; i += CHUNK) {
      const slice = requests.slice(i, i + CHUNK);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: slice },
      });
      console.log(`[prune-shared-mmsi] deleted batch ${i / CHUNK + 1} (${slice.length} rows)`);
    }
    console.log(`[prune-shared-mmsi] done — deleted ${toDelete.length} rows`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => { console.error("[prune-shared-mmsi] failed", e); process.exitCode = 1; });
