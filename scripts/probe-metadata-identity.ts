/* eslint-disable no-console */
// Read-only diagnostic: classify every ship_metadata row against the DB's
// vessel identities so we can plan a safe name correction.
//
// WHY: ship_metadata rows carry stale vessel names (e.g. a row still reading
// "THOMSON DESTINY [2005-2012] - Thomson Cruises" for a hull the DB now calls
// "CELESTYAL OLYMPIA - Celestyal Cruises"). A stale name breaks the per-vessel
// (mmsi, ship_name) window lookup in lib/sheets/ship-metadata.ts. Before
// writing any correction we need to know how many rows are unambiguously
// fixable and how many need a human decision.
//
// This script WRITES NOTHING. It prints counts only; the per-row detail goes
// to tmp/metadata-identity-review.tsv for you to open in a spreadsheet.
//
// Per .claude/rules/data-privacy.md: share the COUNTS with AI if useful, never
// the TSV contents.
//
// Usage:
//   npm run probe:metadata-identity

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { Pool } from "pg";

const TAB = "ship_metadata";
const VOYAGE_START = "2015-01-01";
const OUT_FILE = path.join("tmp", "metadata-identity-review.tsv");

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
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
}

// Same normalisation as lib/sheets/ship-metadata.ts vesselKey — keep in sync.
function vesselKey(mmsi: number, shipName: string): string {
  return `${mmsi}|${shipName.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

type DbShip = {
  ship_id: number;
  mmsi: number;
  imo: string;
  ship_name: string;
  cruise_line: string;
  voyage_count: number;
  qualifying_voyages: number;
  first_start: string;
  last_end: string;
};

// One ship row per (id) with its voyage span. `qualifying_voyages` mirrors the
// filter used by sync-ship-metadata / rekey-metadata (visible, post-2015, with
// an undeleted cruise-globe print) so we can tell a live vessel from a dormant
// era row.
//
// Prints are pre-aggregated into `vp` rather than checked with a correlated
// EXISTS per voyage — the correlated form is what timed out the snapshot query.
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
        COUNT(*)::int                       AS voyage_count,
        MIN(v.start_date)                   AS first_start,
        MAX(v.end_date)                     AS last_end,
        COUNT(*) FILTER (
          WHERE v.visible_on_globe = TRUE
            AND v.start_date > $1::date
            AND vp.voyage_id IS NOT NULL
        )::int                              AS qualifying_voyages
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
      vs.voyage_count,
      vs.qualifying_voyages,
      to_char(vs.first_start, 'YYYY-MM-DD')       AS first_start,
      to_char(vs.last_end, 'YYYY-MM-DD')          AS last_end
    FROM ships s
    JOIN vs ON vs.ship_id = s.id
    WHERE s.is_river_cruise_ship = FALSE
      AND s.mmsi IS NOT NULL
      -- Same universe as fix-metadata-names / append-missing-ships: hidden
      -- ships are excluded. IS NOT FALSE, not = TRUE: NULL means "not hidden".
      AND s.visible_on_globe IS NOT FALSE
    ORDER BY s.mmsi, s.id
  `,
    [VOYAGE_START],
  );
  return res.rows;
}

type SheetRow = {
  rowNum: number;
  name: string;
  cruise_line: string;
  mmsi: number;
  tier: string;
  imo: string;
};

// Row classes, in the order we test them.
type Klass =
  | "exact-current"   // name matches the most-recently-active ship row for this MMSI
  | "exact-dormant"   // name matches a real ship row, but a newer row on the same MMSI is active
  | "rename-unique"   // no name match; MMSI resolves to exactly one ship row
  | "rename-by-imo"   // no name match; sheet imo_number resolves to exactly one ship row
  | "ambiguous"       // no name match; several candidates and nothing to discriminate
  | "orphan";         // MMSI has no ship row with voyages since 2015

const tsvEscape = (v: string | number) => String(v).replace(/[\t\r\n]+/g, " ");

async function main() {
  console.log("[probe-metadata-identity] read-only — writes nothing to the sheet or DB");

  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    max: 2,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log("[probe-metadata-identity] step 1/3: fetching DB ship identities...");
    const t0 = Date.now();
    const dbShips = await fetchDbShips(pool);
    console.log(`[probe-metadata-identity]   ship rows with voyages since ${VOYAGE_START}: ${dbShips.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const byMmsi = new Map<number, DbShip[]>();
    const byMmsiName = new Map<string, DbShip>();
    const byImo = new Map<string, DbShip[]>();
    for (const s of dbShips) {
      const arr = byMmsi.get(s.mmsi) ?? [];
      arr.push(s);
      byMmsi.set(s.mmsi, arr);
      byMmsiName.set(vesselKey(s.mmsi, s.ship_name), s);
      if (s.imo) {
        const ia = byImo.get(s.imo) ?? [];
        ia.push(s);
        byImo.set(s.imo, ia);
      }
    }

    // The active row for an MMSI = latest last_end; ties broken by higher id.
    const activeByMmsi = new Map<number, DbShip>();
    for (const [mmsi, arr] of byMmsi) {
      const active = [...arr].sort((a, b) =>
        a.last_end === b.last_end ? b.ship_id - a.ship_id : a.last_end < b.last_end ? 1 : -1,
      )[0];
      activeByMmsi.set(mmsi, active);
    }

    const sharedMmsi = [...byMmsi.entries()].filter(([, a]) => a.length > 1);
    const sharedMmsiDistinctImo = sharedMmsi.filter(([, a]) => {
      const imos = new Set(a.map((s) => s.imo).filter(Boolean));
      return imos.size > 1;
    });
    const sharedImo = [...byImo.entries()].filter(([, a]) => new Set(a.map((s) => s.mmsi)).size > 1);
    const withImo = dbShips.filter((s) => s.imo).length;

    console.log("");
    console.log("  DB identity shape");
    console.log(`    distinct MMSIs                              : ${byMmsi.size}`);
    console.log(`    ship rows carrying an imo_number            : ${withImo} / ${dbShips.length}`);
    console.log(`    MMSIs with >1 ship row                      : ${sharedMmsi.length} (covering ${sharedMmsi.reduce((n, [, a]) => n + a.length, 0)} rows)`);
    console.log(`      ...of which carry >1 DISTINCT imo (2 hulls): ${sharedMmsiDistinctImo.length}   <-- MMSI grouping merges different hulls here`);
    console.log(`    IMOs appearing under >1 MMSI                : ${sharedImo.length}`);

    console.log("");
    console.log("[probe-metadata-identity] step 2/3: reading ship_metadata sheet...");
    const { sheets, spreadsheetId } = getSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A1:H` });
    const raw = (res.data.values ?? []) as string[][];
    const header = raw[0] ?? [];
    const hasImoCol = (header[7] ?? "").trim() === "imo_number";
    console.log(`[probe-metadata-identity]   sheet data rows: ${Math.max(0, raw.length - 1)}`);
    console.log(`[probe-metadata-identity]   imo_number column present: ${hasImoCol ? "yes" : "NO (col H empty/absent)"}`);

    const sheetRows: SheetRow[] = [];
    for (let i = 1; i < raw.length; i++) {
      const r = raw[i];
      const mmsiStr = (r[2] ?? "").trim();
      if (!mmsiStr) continue;
      const mmsi = Number(mmsiStr);
      if (!Number.isInteger(mmsi) || mmsi <= 0) continue;
      sheetRows.push({
        rowNum: i + 1,
        name: (r[0] ?? "").trim(),
        cruise_line: (r[1] ?? "").trim(),
        mmsi,
        tier: (r[6] ?? "").trim(),
        imo: (r[7] ?? "").trim(),
      });
    }
    const sheetImoPopulated = sheetRows.filter((r) => r.imo).length;
    console.log(`[probe-metadata-identity]   rows with a populated imo_number: ${sheetImoPopulated} / ${sheetRows.length}`);

    console.log("");
    console.log("[probe-metadata-identity] step 3/3: classifying rows...");

    // Which (mmsi, name) pairs the sheet already occupies — used to spot a
    // rename that would collide with an existing row (a merge, not a rename).
    const sheetKeys = new Set(sheetRows.map((r) => vesselKey(r.mmsi, r.name)));

    type Classified = SheetRow & {
      klass: Klass;
      target?: DbShip;
      collides: boolean;
      note: string;
    };

    const classified: Classified[] = sheetRows.map((r) => {
      const candidates = byMmsi.get(r.mmsi) ?? [];
      const exact = byMmsiName.get(vesselKey(r.mmsi, r.name));
      const active = activeByMmsi.get(r.mmsi);

      if (exact) {
        if (active && active.ship_id === exact.ship_id) {
          return { ...r, klass: "exact-current", target: exact, collides: false, note: "" };
        }
        return {
          ...r,
          klass: "exact-dormant",
          target: active,
          collides: active ? sheetKeys.has(vesselKey(r.mmsi, active.ship_name)) : false,
          note: `matched ship_id ${exact.ship_id} last sailed ${exact.last_end}; active row is ship_id ${active?.ship_id} to ${active?.last_end}`,
        };
      }

      if (candidates.length === 0) {
        return { ...r, klass: "orphan", collides: false, note: "no ship row on this MMSI with voyages since " + VOYAGE_START };
      }

      if (candidates.length === 1) {
        const t = candidates[0];
        return {
          ...r,
          klass: "rename-unique",
          target: t,
          collides: sheetKeys.has(vesselKey(r.mmsi, t.ship_name)),
          note: "",
        };
      }

      if (r.imo) {
        const imoMatches = (byImo.get(r.imo) ?? []).filter((s) => s.mmsi === r.mmsi);
        if (imoMatches.length === 1) {
          const t = imoMatches[0];
          return {
            ...r,
            klass: "rename-by-imo",
            target: t,
            collides: sheetKeys.has(vesselKey(r.mmsi, t.ship_name)),
            note: `imo ${r.imo} resolves within ${candidates.length} same-MMSI candidates`,
          };
        }
      }

      return {
        ...r,
        klass: "ambiguous",
        collides: false,
        note: `${candidates.length} ship rows on this MMSI, no imo discriminator`,
      };
    });

    const counts = new Map<Klass, number>();
    const t12counts = new Map<Klass, number>();
    let collisions = 0;
    for (const c of classified) {
      counts.set(c.klass, (counts.get(c.klass) ?? 0) + 1);
      if (c.tier === "1" || c.tier === "2") t12counts.set(c.klass, (t12counts.get(c.klass) ?? 0) + 1);
      if (c.collides) collisions++;
    }

    const ORDER: Klass[] = ["exact-current", "exact-dormant", "rename-unique", "rename-by-imo", "ambiguous", "orphan"];
    console.log("");
    console.log("  sheet row classification            all    T1+T2");
    for (const k of ORDER) {
      console.log(`    ${k.padEnd(32)}${String(counts.get(k) ?? 0).padStart(5)}${String(t12counts.get(k) ?? 0).padStart(9)}`);
    }
    console.log(`    (renames colliding with an existing sheet row: ${collisions} — these are merges, not renames)`);

    // Gap-cruises impact: how many in-scope MMSIs carry >1 ship row, i.e. how
    // many gap rows get labelled from an arbitrary (oldest) ship row.
    const t12Mmsis = new Set(classified.filter((c) => c.tier === "1" || c.tier === "2").map((c) => c.mmsi));
    let t12MultiRow = 0;
    let t12MultiHull = 0;
    for (const m of t12Mmsis) {
      const arr = byMmsi.get(m) ?? [];
      if (arr.length > 1) t12MultiRow++;
      if (new Set(arr.map((s) => s.imo).filter(Boolean)).size > 1) t12MultiHull++;
    }
    console.log("");
    console.log("  gap-cruises impact (T1+T2 scope)");
    console.log(`    MMSIs in scope                              : ${t12Mmsis.size}`);
    console.log(`    ...with >1 ship row (label is arbitrary)    : ${t12MultiRow}`);
    console.log(`    ...with >1 distinct hull (timelines merged) : ${t12MultiHull}`);

    // Per-row detail goes to a file, never to stdout.
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const lines = [
      [
        "class", "sheet_row", "sheet_name", "cruise_line", "mmsi", "tier", "sheet_imo",
        "suggested_name", "suggested_cruise_line", "suggested_ship_id", "suggested_imo",
        "suggested_first_voyage", "suggested_last_voyage", "qualifying_voyages", "collides_with_existing_row", "note",
      ].join("\t"),
      ...classified
        .filter((c) => c.klass !== "exact-current")
        .sort((a, b) => ORDER.indexOf(a.klass) - ORDER.indexOf(b.klass) || a.mmsi - b.mmsi)
        .map((c) =>
          [
            c.klass, c.rowNum, c.name, c.cruise_line, c.mmsi, c.tier, c.imo,
            c.target?.ship_name ?? "", c.target?.cruise_line ?? "", c.target?.ship_id ?? "", c.target?.imo ?? "",
            c.target?.first_start ?? "", c.target?.last_end ?? "", c.target?.qualifying_voyages ?? "",
            c.collides ? "YES" : "", c.note,
          ].map(tsvEscape).join("\t"),
        ),
    ];
    fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
    console.log("");
    console.log(`[probe-metadata-identity] per-row detail (${lines.length - 1} rows needing review) written to ${OUT_FILE}`);
    console.log("[probe-metadata-identity] open it in a spreadsheet — do not paste its contents into AI chat");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[probe-metadata-identity] failed", err);
  process.exitCode = 1;
});
