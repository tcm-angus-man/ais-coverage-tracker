/* eslint-disable no-console */
// Read-only diagnostic: find ships whose display_name no longer matches their
// current `name`. The convention in this DB is display_name = "<NAME> - <Cruise Line>"
// (sometimes "<NAME> [years] - <Cruise Line>"). When a hull is renamed but the
// display_name isn't updated, the embedded name drifts from `name`.
//
// Prompted by MAJESTY OF THE OCEANS (id 393): name was updated to
// "MAJESTY OF THE OCEANS" but display_name still reads
// "MAJESTY OF THE SEAS - Seajets Cruise Line".
//
// This flags candidates for a human to review. It does NOT write anything.
// Per .claude/rules/data-privacy.md, share only counts/flagged names with AI,
// not bulk data dumps.
//
// Usage:
//   npm run check:display-name-drift

import { Pool } from "pg";

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} env var not set`);
  return v;
}

type Row = {
  id: number;
  name: string;
  display_name: string;
  cruise_line: string;
  mmsi: number | null;
};

// Normalize for loose comparison: uppercase, strip non-alphanumerics.
function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Extract the leading "name" portion of a display_name, i.e. the text before
// the first " - " (cruise line separator) and before any " [years]" suffix.
function displayNamePrefix(displayName: string): string {
  // Cut at " - " (cruise line separator)
  let head = displayName.split(" - ")[0];
  // Strip a trailing " [....]" segment (year range)
  head = head.replace(/\s*\[[^\]]*\]\s*$/, "");
  return head.trim();
}

async function main() {
  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    max: 1,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    const res = await pool.query<Row>(`
      SELECT
        s.id::int                                  AS id,
        COALESCE(s.name, '')::text                 AS name,
        COALESCE(s.display_name, '')::text         AS display_name,
        COALESCE(s.cruise_line, '')::text          AS cruise_line,
        s.mmsi::int                                AS mmsi
      FROM ships s
      WHERE s.is_river_cruise_ship = FALSE
        AND s.display_name IS NOT NULL
        AND s.name IS NOT NULL
      ORDER BY s.mmsi NULLS LAST, s.id
    `);

    const drift: Row[] = [];
    for (const r of res.rows) {
      const prefix = displayNamePrefix(r.display_name);
      if (norm(prefix) !== norm(r.name)) {
        drift.push(r);
      }
    }

    console.log(`[check-display-name-drift] ships scanned: ${res.rows.length}`);
    console.log(`[check-display-name-drift] display_name prefix != name: ${drift.length}`);
    console.log("");
    console.log("id\tmmsi\tname\t|\tdisplay_name");
    console.log("--\t----\t----\t \t------------");
    for (const r of drift) {
      console.log(`${r.id}\t${r.mmsi ?? ""}\t${r.name}\t|\t${r.display_name}`);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[check-display-name-drift] failed", err);
  process.exitCode = 1;
});
