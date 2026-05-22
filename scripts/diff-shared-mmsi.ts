/* eslint-disable no-console */
// Diagnostic: compare current ship_metadata sheet against the stricter
// "cruise globe + start_date > 2015-01-01 + visible_on_globe" qualifying
// set. Prints which sheet rows no longer qualify so we can decide whether
// to leave them, flag them, or clean up manually.
//
// Read-only: never writes to the sheet.

import { google } from "googleapis";
import { Pool } from "pg";

function getEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`${k} env var not set`); return v; }

async function main() {
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
    console.log(`[diff] qualifying ships in DB: ${dbResult.rows.length}`);

    const email = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    const privateKey = getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n").replace(/^"|"$/g, "");
    const spreadsheetId = getEnv("GOOGLE_SHEETS_ID");
    const auth = new google.auth.GoogleAuth({ credentials: { client_email: email, private_key: privateKey }, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "ship_metadata!A1:G" });
    const rows = (res.data.values ?? []) as string[][];
    console.log(`[diff] sheet rows: ${rows.length - 1}`);

    const nonQualifying: { rowNum: number; mmsi: number; name: string }[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] ?? "").trim();
      const mmsiStr = (r[2] ?? "").trim();
      if (!mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
      const key = `${mmsi}|${name.toLowerCase()}`;
      if (!qualifying.has(key)) nonQualifying.push({ rowNum: i + 1, mmsi, name });
    }

    console.log(`[diff] sheet rows that do NOT meet new filter: ${nonQualifying.length}`);
    if (nonQualifying.length > 0) {
      console.log(`[diff] first 30:`);
      for (const r of nonQualifying.slice(0, 30)) {
        console.log(`    row=${r.rowNum} mmsi=${r.mmsi} ${r.name}`);
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => { console.error("[diff] failed", e); process.exitCode = 1; });
