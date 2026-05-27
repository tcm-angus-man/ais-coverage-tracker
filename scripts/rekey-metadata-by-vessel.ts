/* eslint-disable no-console */
// One-shot: rewrite ship_metadata to one row per (mmsi, ship_name) vessel and
// backfill the imo_number column (col H).
//
// WHY: the sheet was MMSI-keyed with one row per MMSI. Two hulls that share an
// MMSI (a resold/renamed ship keeps its AIS unit — e.g. VILLA VIE ODYSSEY and
// BRAEMAR share MMSI 311541000) collapsed to a single row, so one vessel
// inherited the other's service window and showed 0% / wrong dates. Keying by
// (mmsi, ship_name) gives each vessel its own row + window.
//
// PRESERVES curated data: existing service_start / service_end / tier /
// cruise_type for a matched (mmsi, name) row are carried over verbatim — this
// script never blanks or shrinks a window you've set. It only adds missing
// vessel rows and fills imo_number.
//
// Writes the FULL sheet via values.update (A:H), so review the dry-run diff
// before applying.
//
// Usage:
//   npm run sheet:rekey-metadata           # dry run, prints diff summary
//   npm run sheet:rekey-metadata -- apply  # rewrite the sheet
//
// Inline Sheets + Postgres bootstrap (mirrors scripts/fill-shared-mmsi.ts) so
// this doesn't import lib/sheets/* (which uses `server-only`).

import { google } from "googleapis";
import { Pool } from "pg";

const HEADER = [
  "ship_name",
  "cruise_line",
  "mmsi",
  "cruise_type",
  "service_start",
  "service_end",
  "tier",
  "imo_number",
] as const;

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

// Same normalisation as lib/sheets/ship-metadata.ts vesselKey — keep in sync.
function vesselKey(mmsi: number, shipName: string): string {
  const name = shipName.toLowerCase().replace(/\s+/g, " ").trim();
  return `${mmsi}|${name}`;
}

const safe = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

type Curated = {
  cruise_type: string;
  service_start: string;
  service_end: string;
  tier: string;
  imo_number: string;
};

async function main() {
  const apply = process.argv.includes("apply");
  console.log(`[rekey-metadata] mode=${apply ? "APPLY" : "dry-run"}`);

  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    max: 2,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    // Qualifying ships — same universe as fetchShips / fill-shared-mmsi.
    const dbResult = await pool.query<{
      mmsi: number;
      ship_name: string;
      cruise_line: string;
      imo_number: string;
    }>(`
      SELECT
        s.mmsi::int AS mmsi,
        COALESCE(s.display_name, s.name, '')::text AS ship_name,
        COALESCE(s.cruise_line, '')::text AS cruise_line,
        COALESCE(s.imo_number::text, '')::text AS imo_number
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
    console.log(`[rekey-metadata] db qualifying ships: ${dbResult.rows.length}`);

    const { sheets, spreadsheetId } = getSheetsClient();
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "ship_metadata!A1:H",
    });
    const rows = (sheetRes.data.values ?? []) as string[][];
    console.log(`[rekey-metadata] existing sheet data rows: ${Math.max(0, rows.length - 1)}`);

    // Curated values to preserve, keyed by (mmsi, name). If the old sheet had
    // duplicate (mmsi, name) rows, the first non-empty value wins per field.
    const curated = new Map<string, Curated>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] ?? "").trim();
      const mmsiStr = (r[2] ?? "").trim();
      if (!name || !mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
      const k = vesselKey(mmsi, name);
      const existing = curated.get(k);
      const next: Curated = {
        cruise_type:   existing?.cruise_type   || (r[3] ?? "").trim(),
        service_start: existing?.service_start || (r[4] ?? "").trim(),
        service_end:   existing?.service_end   || (r[5] ?? "").trim(),
        tier:          existing?.tier          || (r[6] ?? "").trim(),
        imo_number:    existing?.imo_number    || (r[7] ?? "").trim(),
      };
      curated.set(k, next);
    }

    // Build the new sheet: one row per qualifying (mmsi, name) vessel.
    const out: (string | number)[][] = [[...HEADER]];
    let preserved = 0, newRows = 0, imoBackfilled = 0, windowKept = 0;
    const seen = new Set<string>();
    for (const s of dbResult.rows) {
      const name = safe(s.ship_name);
      if (!name) continue;
      const k = vesselKey(s.mmsi, name);
      if (seen.has(k)) continue; // collapse exact (mmsi, name) dupes from db
      seen.add(k);

      const c = curated.get(k);
      if (c) preserved++; else newRows++;
      if (c?.service_start || c?.service_end) windowKept++;

      // imo_number: prefer the curated sheet value if present, else backfill
      // from Postgres. Never blank an existing sheet imo.
      const imo = c?.imo_number || s.imo_number || "";
      if (!c?.imo_number && s.imo_number) imoBackfilled++;

      out.push([
        name,
        safe(s.cruise_line),
        s.mmsi,
        c?.cruise_type ?? "",
        c?.service_start ?? "",
        c?.service_end ?? "",
        c?.tier || "4",
        imo,
      ]);
    }

    console.log(`[rekey-metadata] new sheet rows: ${out.length - 1}`);
    console.log(`[rekey-metadata]   preserved (matched existing): ${preserved}`);
    console.log(`[rekey-metadata]   brand-new vessel rows: ${newRows}`);
    console.log(`[rekey-metadata]   rows with a service window kept: ${windowKept}`);
    console.log(`[rekey-metadata]   imo_number backfilled from db: ${imoBackfilled}`);

    // Surface vessels that share an MMSI — these are the ones the old keying
    // broke. Helpful to eyeball that both halves now have distinct rows.
    const byMmsi = new Map<number, string[]>();
    for (let i = 1; i < out.length; i++) {
      const mmsi = Number(out[i][2]);
      const arr = byMmsi.get(mmsi) ?? [];
      arr.push(String(out[i][0]));
      byMmsi.set(mmsi, arr);
    }
    const shared = [...byMmsi.entries()].filter(([, names]) => names.length > 1);
    console.log(`[rekey-metadata] shared-MMSI vessels: ${shared.length} MMSIs covering ${shared.reduce((n, [, names]) => n + names.length, 0)} rows`);
    for (const [mmsi, names] of shared.slice(0, 15)) {
      console.log(`    ${mmsi}: ${names.join(" | ")}`);
    }

    if (!apply) {
      console.log(`[rekey-metadata] dry run — re-run with 'apply' to rewrite the sheet`);
      return;
    }

    // Clear then write the full range so removed/reordered rows don't linger.
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: "ship_metadata!A:H" });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "ship_metadata!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: out },
    });
    console.log(`[rekey-metadata] rewrote ${out.length} rows (incl. header)`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[rekey-metadata] failed", err);
  process.exitCode = 1;
});
