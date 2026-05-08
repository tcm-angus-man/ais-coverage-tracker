import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsGet, sheetsAppend, sheetsUpdateRow } from "@/lib/sheets/client";
import { ASSIGNMENTS_COLUMNS } from "@/lib/sheets/schemas";
import { z } from "zod";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["queued", "in_progress", "done", "blocked"] as const;

// Assigners can patch any field; cleaners can only update status on their own assignment.
const AssignerPatchSchema = z.object({
  status:   z.enum(VALID_STATUSES).optional(),
  assignee: z.string().min(1).optional(),
  notes:    z.string().optional(),
});

const CleanerPatchSchema = z.object({
  status: z.enum(VALID_STATUSES),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }

    const role = session.user.role;
    const actorSlug = session.user.slug ?? "unknown";

    if (role !== "assigner" && role !== "cleaner") {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const body = await req.json();

    let patch: z.infer<typeof AssignerPatchSchema>;
    if (role === "assigner") {
      const parsed = AssignerPatchSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
      }
      patch = parsed.data;
    } else {
      const parsed = CleanerPatchSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
      }
      patch = parsed.data;
    }

    // Find the row in the sheet
    const rows = await sheetsGet("assignments!A:M");
    // rows[0] is header, data starts at rows[1] (sheet row 2)
    const idCol = ASSIGNMENTS_COLUMNS.indexOf("assignment_id");
    const dataRows = rows.slice(1);
    const rowIndex = dataRows.findIndex(r => r[idCol] === params.id);

    if (rowIndex === -1) {
      return NextResponse.json({ ok: false, error: "assignment not found" }, { status: 404 });
    }

    const existingRow = dataRows[rowIndex];
    const sheetRow = rowIndex + 2; // +1 for header, +1 for 1-based index

    // Cleaners can only update their own assignments
    if (role === "cleaner") {
      const assigneeCol = ASSIGNMENTS_COLUMNS.indexOf("assignee");
      if (existingRow[assigneeCol] !== actorSlug) {
        return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
    }

    const now = new Date().toISOString();

    // Build updated row: start from existing, apply patch fields
    const updated = [...existingRow];
    // Pad to full column width if row is short
    while (updated.length < ASSIGNMENTS_COLUMNS.length) updated.push("");

    if (patch.status !== undefined) {
      updated[ASSIGNMENTS_COLUMNS.indexOf("status")] = patch.status;
    }
    if ("assignee" in patch && patch.assignee !== undefined) {
      updated[ASSIGNMENTS_COLUMNS.indexOf("assignee")] = patch.assignee;
    }
    if ("notes" in patch && patch.notes !== undefined) {
      updated[ASSIGNMENTS_COLUMNS.indexOf("notes")] = patch.notes;
    }
    updated[ASSIGNMENTS_COLUMNS.indexOf("updated_at")] = now;
    updated[ASSIGNMENTS_COLUMNS.indexOf("updated_by")] = actorSlug;

    const range = `assignments!A${sheetRow}:M${sheetRow}`;
    await sheetsUpdateRow(range, updated);

    // Audit log (best-effort)
    const auditRow = [
      now,
      actorSlug,
      "update",
      params.id,
      Object.keys(patch).join(","),
      "",
      JSON.stringify(patch),
    ];
    sheetsAppend("audit_log!A:G", [auditRow]).catch(e =>
      console.error("[PATCH assignments] audit append failed:", e),
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /api/sheets/assignments/[id]]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
