import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsAppend } from "@/lib/sheets/client";
import { TEAM_MEMBERS } from "@/lib/sheets/team-config";
import { z } from "zod";

export const dynamic = "force-dynamic";

const AssignmentSchema = z.object({
  assignment_id: z.string().uuid(),
  ship_id:       z.number().int().positive(),
  ship_mmsi:     z.number().int(),
  ship_name:     z.string().min(1),
  cruise_line:   z.string(),
  date_start:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_end:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assignee:      z.string().min(1),
  notes:         z.string().default(""),
});

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }
    // Only assigners can create assignments
    if (session.user.role !== "assigner") {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const parsed = AssignmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const d = parsed.data;

    // Validate assignee slug exists in team config
    const assigneeMember = TEAM_MEMBERS.find(m => m.slug === d.assignee && m.active);
    if (!assigneeMember) {
      return NextResponse.json({ ok: false, error: `Unknown assignee: ${d.assignee}` }, { status: 400 });
    }

    const now = new Date().toISOString();
    const actor = session.user.slug ?? "unknown";

    const assignmentRow = [
      d.assignment_id,
      now,             // created_at
      actor,           // created_by
      d.ship_mmsi,
      d.ship_name,
      d.cruise_line,
      d.date_start,
      d.date_end,
      d.assignee,
      "queued",        // status
      d.notes ? `[${actor} @ ${now}]\n${d.notes}` : "",
      now,             // updated_at
      actor,           // updated_by
      d.ship_id,
    ];

    const auditRow = [
      now,
      actor,
      "create",
      d.assignment_id,
      "*",
      "",
      JSON.stringify({ assignee: d.assignee, date_start: d.date_start, date_end: d.date_end }),
    ];

    // Assignment write must succeed; audit failure is best-effort
    const [assignResult, auditResult] = await Promise.allSettled([
      sheetsAppend("assignments!A:N", [assignmentRow]),
      sheetsAppend("audit_log!A:G",   [auditRow]),
    ]);

    if (assignResult.status === "rejected") {
      console.error("[/api/sheets/assignments] assignment append failed:", assignResult.reason);
      return NextResponse.json(
        { ok: false, error: assignResult.reason instanceof Error ? assignResult.reason.message : String(assignResult.reason) },
        { status: 500 },
      );
    }

    if (auditResult.status === "rejected") {
      console.error("[/api/sheets/assignments] audit append failed:", auditResult.reason);
    }

    return NextResponse.json({ ok: true, assignment_id: d.assignment_id });

  } catch (err) {
    console.error("[/api/sheets/assignments]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
