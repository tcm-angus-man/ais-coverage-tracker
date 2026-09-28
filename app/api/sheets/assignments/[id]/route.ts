import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsGet, sheetsAppend, sheetsUpdateRow } from "@/lib/sheets/client";
import { ASSIGNMENTS_COLUMNS } from "@/lib/sheets/schemas";
import { TEAM_MEMBERS } from "@/lib/sheets/team-config";
import { appendNote } from "@/lib/sheets/notes";
import { canAssign } from "@/lib/roles";
import { z } from "zod";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["queued", "in_progress", "done", "blocked", "cancelled"] as const;

// One schema for every team member — any active member may change any
// assignment. completed_at is deliberately absent: the server owns it.
// zod strips unknown keys, so a body-supplied completed_at is ignored.
const PatchSchema = z.object({
  status:   z.enum(VALID_STATUSES).optional(),
  assignee: z.string().min(1).optional(),
  notes:    z.string().optional(),
});

type Column = (typeof ASSIGNMENTS_COLUMNS)[number];
const col = (c: Column) => ASSIGNMENTS_COLUMNS.indexOf(c);

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }
    if (!canAssign(session)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const patch = parsed.data;

    // Same check as POST: never write an assignee the team doesn't have.
    if (patch.assignee !== undefined && !TEAM_MEMBERS.some(m => m.slug === patch.assignee && m.active)) {
      return NextResponse.json({ ok: false, error: `Unknown assignee: ${patch.assignee}` }, { status: 400 });
    }

    const actor = session.user.slug ?? "unknown";
    const rows = await sheetsGet("assignments!A:O");
    // rows[0] is the header; data starts at sheet row 2
    const dataRows = rows.slice(1);
    const rowIndex = dataRows.findIndex(r => r[col("assignment_id")] === params.id);
    if (rowIndex === -1) {
      return NextResponse.json({ ok: false, error: "assignment not found" }, { status: 404 });
    }
    const sheetRow = rowIndex + 2;

    // Pad legacy rows written before column O existed.
    const updated = [...dataRows[rowIndex]];
    while (updated.length < ASSIGNMENTS_COLUMNS.length) updated.push("");

    const now = new Date().toISOString();
    const before: Partial<Record<Column, string>> = {};
    const after: Partial<Record<Column, string>> = {};
    const set = (c: Column, value: string) => {
      if (!(c in before)) before[c] = updated[col(c)] ?? "";
      updated[col(c)] = value;
      after[c] = value;
    };

    const prevStatus = updated[col("status")] || "queued";
    if (patch.assignee !== undefined) set("assignee", patch.assignee);
    if (patch.notes !== undefined) set("notes", patch.notes);
    if (patch.status !== undefined) {
      set("status", patch.status);
      if (patch.status === "done" && prevStatus !== "done") set("completed_at", now);
      if (patch.status !== "done" && prevStatus === "done") set("completed_at", "");
      if (patch.status === "cancelled" && prevStatus !== "cancelled") {
        set("notes", appendNote(updated[col("notes")] ?? "", actor, now, "cancelled"));
      }
    }
    updated[col("updated_at")] = now;
    updated[col("updated_by")] = actor;

    await sheetsUpdateRow(`assignments!A${sheetRow}:O${sheetRow}`, updated);

    // Audit log (best-effort, per .claude/rules/sheets-integration.md)
    const auditRow = [
      now,
      actor,
      "update",
      params.id,
      Object.keys(after).join(","),
      JSON.stringify(before),
      JSON.stringify(after),
    ];
    sheetsAppend("audit_log!A:G", [auditRow]).catch(e =>
      console.error("[PATCH assignments] audit append failed:", e),
    );

    return NextResponse.json({
      ok: true,
      updated: {
        status: updated[col("status")] || "queued",
        assignee: updated[col("assignee")] ?? "",
        notes: updated[col("notes")] ?? "",
        completed_at: updated[col("completed_at")] ?? "",
        updated_at: now,
        updated_by: actor,
      },
    });
  } catch (err) {
    console.error("[PATCH /api/sheets/assignments/[id]]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
