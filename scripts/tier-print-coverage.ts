/* eslint-disable no-console */
// One-shot: prints the share of `prints` covered by each tier within
// the snapshot voyage window (2015-01-01 → today).
//
// Usage:  npm run tier:coverage
//
// Inline Sheets + Postgres bootstrap so the script doesn't go through
// lib/sheets/ship-metadata.ts (which uses `server-only`, a Next.js-only
// guard that throws when run from plain Node).
//
// Per .claude/rules/data-privacy.md, do not paste this script's output
// back into AI chat — only the aggregate percentage.

import { google } from "googleapis";
import { Pool } from "pg";

const VOYAGE_START = "2015-01-01";

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} env var not set`);
  return v;
}

async function fetchTierByMmsi(): Promise<Map<number, 1 | 2 | 3 | 4>> {
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "ship_metadata!A1:G" });
  const rows = (res.data.values ?? []) as string[][];

  const tierByMmsi = new Map<number, 1 | 2 | 3 | 4>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const mmsi = Number((r[2] ?? "").trim());
    const tier = Number((r[6] ?? "").trim());
    if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
    if (tier !== 1 && tier !== 2 && tier !== 3 && tier !== 4) continue;
    tierByMmsi.set(mmsi, tier as 1 | 2 | 3 | 4);
  }
  return tierByMmsi;
}

async function fetchPrintCountsByMmsi(pool: Pool): Promise<Map<number, number>> {
  const result = await pool.query<{ mmsi: number; n: string }>(
    `
    SELECT s.mmsi::int AS mmsi, COUNT(*)::text AS n
    FROM prints p
    JOIN voyages v ON v.id = p.voyage_id
    JOIN ships s   ON s.id = v.ship_id
    WHERE p.is_deleted = FALSE
      AND v.is_deleted = FALSE
      AND s.mmsi IS NOT NULL
      AND v.start_date IS NOT NULL
      AND v.end_date   IS NOT NULL
      AND v.end_date   >= $1::date
      AND v.start_date <= CURRENT_DATE
    GROUP BY s.mmsi
    `,
    [VOYAGE_START],
  );
  const m = new Map<number, number>();
  for (const r of result.rows) m.set(r.mmsi, Number(r.n));
  return m;
}

async function main() {
  // Mirror lib/snapshot/db.ts SSL handling: prod requires TLS, localhost
  // does not. Required by pg_hba.conf on the prod DB.
  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  try {
    const [tierByMmsi, printsByMmsi] = await Promise.all([
      fetchTierByMmsi(),
      fetchPrintCountsByMmsi(pool),
    ]);

    const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, unmapped: 0 };
    let total = 0;
    for (const [mmsi, n] of printsByMmsi) {
      total += n;
      const t = tierByMmsi.get(mmsi);
      if (t === undefined) buckets.unmapped += n;
      else buckets[t] += n;
    }

    const t12 = buckets[1] + buckets[2];
    const pct = total === 0 ? 0 : (t12 / total) * 100;

    console.log("Print coverage by tier (voyage window: " + VOYAGE_START + " → today)");
    console.log("  T1 prints:        " + buckets[1].toLocaleString());
    console.log("  T2 prints:        " + buckets[2].toLocaleString());
    console.log("  T3 prints:        " + buckets[3].toLocaleString());
    console.log("  T4 prints:        " + buckets[4].toLocaleString());
    console.log("  unmapped prints:  " + buckets.unmapped.toLocaleString() + "  (mmsi in Postgres but not in ship_metadata)");
    console.log("  TOTAL:            " + total.toLocaleString());
    console.log("");
    console.log("  T1 + T2 share:    " + pct.toFixed(2) + "%  (" + t12.toLocaleString() + " / " + total.toLocaleString() + ")");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
