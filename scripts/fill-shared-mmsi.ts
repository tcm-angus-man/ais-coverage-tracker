/* eslint-disable no-console */
// One-shot: append missing ship_metadata rows for ships sharing an MMSI.
//
// After removing DISTINCT ON (mmsi) from lib/snapshot/queries.ts, ships
// sharing an MMSI now appear as multiple rows in the coverage snapshot.
// The ship_metadata sheet only had one row per MMSI (the surviving ship
// after the old dedupe). This script appends a row for every (ship_name,
// mmsi) pair that now qualifies but isn't yet in the sheet.
//
// Never edits or deletes existing rows — sheets.append only.
//
// Inheritance:
//   - If the MMSI already has at least one row in the sheet, new rows for
//     other ship_names under that MMSI inherit cruise_type / service window
//     / tier from the existing row.
//   - If the MMSI is brand-new to the sheet, the row defaults to tier 4,
//     blank service window, blank cruise_type — edit manually after.
//
// Inline Sheets + Postgres bootstrap (mirrors scripts/tier-print-coverage.ts)
// so the script doesn't go through lib/sheets/*, which uses `server-only`.
//
// Usage:
//   npm run sheet:fill-shared-mmsi          # dry run, prints counts + sample
//   npm run sheet:fill-shared-mmsi -- apply # actually append

import { google } from "googleapis";
import { Pool } from "pg";

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

async function main() {
  const apply = process.argv.includes("apply");
  console.log(`[fill-shared-mmsi] mode=${apply ? "APPLY" : "dry-run"}`);

  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    max: 2,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    // Stricter filter per follow-up: each ship row must itself have at
    // least one voyage that is visible_on_globe = TRUE, has an undeleted
    // print with is_cruise_globe = TRUE, is not deleted, and starts after
    // 2015-01-01. The cruise_globe flag lives on prints, not voyages.
    const dbResult = await pool.query<{ mmsi: number; ship_name: string; cruise_line: string }>(`
      SELECT
        s.mmsi::int AS mmsi,
        COALESCE(s.display_name, s.name, '')::text AS ship_name,
        COALESCE(s.cruise_line, '')::text AS cruise_line
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
      ORDER BY s.mmsi ASC, ship_name ASC
    `);
    console.log(`[fill-shared-mmsi] db ships qualifying: ${dbResult.rows.length}`);

    const { sheets, spreadsheetId } = getSheetsClient();
    const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: "ship_metadata!A1:G" });
    const rows = (sheetRes.data.values ?? []) as string[][];
    console.log(`[fill-shared-mmsi] sheet data rows: ${rows.length - 1}`);

    const existingPairs = new Set<string>();
    const metaByMmsi = new Map<number, { cruise_type: string; service_start: string; service_end: string; tier: string }>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] ?? "").trim();
      const mmsiStr = (r[2] ?? "").trim();
      if (!mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
      existingPairs.add(`${mmsi}|${name.toLowerCase()}`);
      if (!metaByMmsi.has(mmsi)) {
        metaByMmsi.set(mmsi, {
          cruise_type: (r[3] ?? "").trim(),
          service_start: (r[4] ?? "").trim(),
          service_end: (r[5] ?? "").trim(),
          tier: (r[6] ?? "").trim() || "4",
        });
      }
    }

    const toAppend: (string | number)[][] = [];
    const sharedMmsiAdds: string[] = [];
    const newMmsiAdds: string[] = [];
    const safe = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

    for (const s of dbResult.rows) {
      const key = `${s.mmsi}|${s.ship_name.trim().toLowerCase()}`;
      if (existingPairs.has(key)) continue;
      const meta = metaByMmsi.get(s.mmsi);
      if (meta) {
        toAppend.push([
          safe(s.ship_name),
          safe(s.cruise_line),
          s.mmsi,
          meta.cruise_type,
          meta.service_start,
          meta.service_end,
          meta.tier,
        ]);
        sharedMmsiAdds.push(`${s.mmsi} ${s.ship_name}`);
      } else {
        toAppend.push([
          safe(s.ship_name),
          safe(s.cruise_line),
          s.mmsi,
          "",
          "",
          "",
          "4",
        ]);
        newMmsiAdds.push(`${s.mmsi} ${s.ship_name}`);
      }
    }

    console.log(`[fill-shared-mmsi] rows to append: ${toAppend.length}`);
    console.log(`[fill-shared-mmsi]   shared-mmsi adds (inherit metadata): ${sharedMmsiAdds.length}`);
    console.log(`[fill-shared-mmsi]   brand-new mmsi adds (tier 4 default): ${newMmsiAdds.length}`);
    if (sharedMmsiAdds.length > 0) {
      console.log(`[fill-shared-mmsi] shared-mmsi sample (first 10):`);
      for (const s of sharedMmsiAdds.slice(0, 10)) console.log(`    ${s}`);
    }
    if (newMmsiAdds.length > 0) {
      console.log(`[fill-shared-mmsi] new-mmsi sample (first 10):`);
      for (const s of newMmsiAdds.slice(0, 10)) console.log(`    ${s}`);
    }

    if (toAppend.length === 0) {
      console.log(`[fill-shared-mmsi] nothing to do`);
      return;
    }

    if (!apply) {
      console.log(`[fill-shared-mmsi] dry run — re-run with 'apply' to actually append`);
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "ship_metadata!A:G",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: toAppend },
    });
    console.log(`[fill-shared-mmsi] appended ${toAppend.length} rows`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[fill-shared-mmsi] failed", err);
  process.exitCode = 1;
});
