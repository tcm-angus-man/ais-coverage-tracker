import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GatewayDiag = {
  total_rows: number;
  human_touched_rows: number;
  by_updated_by: { updated_by: string | null; count: number }[];
  recent_human_touched: { mmsi: number; date: string; updated_by: string; updated_at: string }[];
};

// Admin-only diagnostic: counts how many silver rows would qualify as
// human-touched, plus a few sample updated_by values, so we can verify the
// snapshot's `u` flag is doing what we expect. Read-only.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "assigner") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    // The gateway runs the queries and returns this route's response shape.
    const diag = await gatewayFetch<GatewayDiag>("ais/snapshot-diag");

    return NextResponse.json({
      ok: true,
      total_rows: diag.total_rows,
      human_touched_rows: diag.human_touched_rows,
      by_updated_by: diag.by_updated_by,
      recent_human_touched: diag.recent_human_touched,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
