import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsGet } from "@/lib/sheets/client";
import { ASSIGNMENTS_COLUMNS } from "@/lib/sheets/schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }

    const rows = await sheetsGet("assignments!A:N");
    // Skip header row
    const data = rows.slice(1);

    const assignments = data
      .filter(row => row[0]) // skip empty rows
      .map(row => ({
        id:          row[ASSIGNMENTS_COLUMNS.indexOf("assignment_id")] ?? "",
        created_at:  row[ASSIGNMENTS_COLUMNS.indexOf("created_at")]    ?? "",
        created_by:  row[ASSIGNMENTS_COLUMNS.indexOf("created_by")]    ?? "",
        ship_id:     Number(row[ASSIGNMENTS_COLUMNS.indexOf("ship_id")]   ?? 0),
        ship_mmsi:   Number(row[ASSIGNMENTS_COLUMNS.indexOf("ship_mmsi")] ?? 0),
        ship_name:   row[ASSIGNMENTS_COLUMNS.indexOf("ship_name")]     ?? "",
        cruise_line: row[ASSIGNMENTS_COLUMNS.indexOf("cruise_line")]   ?? "",
        date_start:  row[ASSIGNMENTS_COLUMNS.indexOf("date_start")]    ?? "",
        date_end:    row[ASSIGNMENTS_COLUMNS.indexOf("date_end")]      ?? "",
        assignee:    row[ASSIGNMENTS_COLUMNS.indexOf("assignee")]      ?? "",
        status:      row[ASSIGNMENTS_COLUMNS.indexOf("status")]        ?? "queued",
        notes:       row[ASSIGNMENTS_COLUMNS.indexOf("notes")]         ?? "",
        updated_at:  row[ASSIGNMENTS_COLUMNS.indexOf("updated_at")]    ?? "",
        updated_by:  row[ASSIGNMENTS_COLUMNS.indexOf("updated_by")]    ?? "",
      }));

    return NextResponse.json({ ok: true, assignments });
  } catch (err) {
    console.error("[GET /api/sheets/assignments/get]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
