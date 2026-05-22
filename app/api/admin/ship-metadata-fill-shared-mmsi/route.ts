import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/snapshot/db";
import { sheetsGet, sheetsAppend } from "@/lib/sheets/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-shot helper: after removing DISTINCT ON (mmsi) from fetchShips, ships
// sharing an MMSI now appear as multiple rows in the coverage snapshot. The
// ship_metadata sheet only had one row per MMSI (the surviving ship after the
// old dedupe). This endpoint appends a row for every ship_name that now
// qualifies but isn't yet represented in the sheet by (ship_name, mmsi).
//
// Existing rows are never touched. New rows inherit tier/service window /
// cruise_type from the existing row for the same MMSI; if none, default to
// tier 4 with empty service window.
//
// dryRun=1 (default): preview only. Pass ?apply=1 to actually append.
type Existing = { cruise_type: string; service_start: string; service_end: string; tier: string };

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    if (session.user.role !== "assigner") {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const apply = url.searchParams.get("apply") === "1";

    // Pull every qualifying ship row from Postgres. Same filter as the new
    // fetchShips: non-river-cruise, has mmsi, and has at least one undeleted
    // globe-visible voyage OR appears in silver.
    const pool = getPool();
    const dbResult = await pool.query<{ mmsi: number; ship_name: string; cruise_line: string }>(`
      SELECT
        s.mmsi::int AS mmsi,
        COALESCE(s.display_name, s.name, '')::text AS ship_name,
        COALESCE(s.cruise_line, '')::text AS cruise_line
      FROM ships s
      WHERE s.is_river_cruise_ship = FALSE
        AND s.mmsi IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM voyages v
            WHERE v.ship_id = s.id
              AND v.is_deleted = FALSE
              AND v.visible_on_globe = TRUE
          )
          OR EXISTS (
            SELECT 1 FROM ais_silver_summary ass
            WHERE ass.mmsi = s.mmsi
          )
        )
      ORDER BY s.mmsi ASC, ship_name ASC
    `);

    // Read current sheet. Columns: ship_name, cruise_line, mmsi, cruise_type,
    // service_start, service_end, tier.
    const rows = await sheetsGet("ship_metadata!A1:G");
    const existingPairs = new Set<string>(); // `${mmsi}|${ship_name_lower}`
    const metaByMmsi = new Map<number, Existing>();
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

    // Find ships whose (mmsi, ship_name) pair is missing from the sheet,
    // but only for MMSIs that already have at least one row (per the user
    // brief — we're filling in additional names for existing MMSIs, not
    // adding brand-new MMSIs).
    const toAppend: (string | number)[][] = [];
    const skippedNoMmsi: number[] = [];
    const previewSample: { mmsi: number; ship_name: string; cruise_line: string }[] = [];
    for (const s of dbResult.rows) {
      const key = `${s.mmsi}|${s.ship_name.toLowerCase()}`;
      if (existingPairs.has(key)) continue;
      const meta = metaByMmsi.get(s.mmsi);
      if (!meta) {
        // MMSI not in sheet at all — skip per "don't add brand-new MMSIs"
        // interpretation. Surface count so we can decide later.
        skippedNoMmsi.push(s.mmsi);
        continue;
      }
      // Strip commas for safety; sheets append handles them but keeps output
      // diff-friendly.
      const safe = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
      toAppend.push([
        safe(s.ship_name),
        safe(s.cruise_line),
        s.mmsi,
        meta.cruise_type,
        meta.service_start,
        meta.service_end,
        meta.tier,
      ]);
      if (previewSample.length < 20) {
        previewSample.push({ mmsi: s.mmsi, ship_name: s.ship_name, cruise_line: s.cruise_line });
      }
    }

    if (apply && toAppend.length > 0) {
      // Single append call — sheetsAppend uses INSERT_ROWS so order is
      // preserved and existing rows are untouched.
      await sheetsAppend("ship_metadata!A:G", toAppend);
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      sheet_rows_before: rows.length - 1,
      db_ships: dbResult.rows.length,
      to_append_count: toAppend.length,
      skipped_mmsis_not_in_sheet: skippedNoMmsi.length,
      preview_first_20: previewSample,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
