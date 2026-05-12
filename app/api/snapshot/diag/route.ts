import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/snapshot/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only diagnostic: counts how many silver rows would qualify as
// human-touched, plus a few sample updated_by values, so we can verify the
// snapshot's `u` flag is doing what we expect. Read-only.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "assigner") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const pool = getPool();
    const [totalRes, humanRes, byUserRes, sampleRes] = await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ais_silver_summary`),
      pool.query<{ count: string }>(`
        SELECT COUNT(*) AS count
        FROM ais_silver_summary
        WHERE updated_by IS NOT NULL AND updated_by NOT IN ('data-platform')
      `),
      pool.query<{ updated_by: string | null; count: string }>(`
        SELECT updated_by, COUNT(*) AS count
        FROM ais_silver_summary
        GROUP BY updated_by
        ORDER BY count DESC
        LIMIT 20
      `),
      pool.query<{ mmsi: number; date: string; updated_by: string; updated_at: string }>(`
        SELECT mmsi, date::text, updated_by, updated_at::text
        FROM ais_silver_summary
        WHERE updated_by IS NOT NULL AND updated_by NOT IN ('data-platform')
        ORDER BY updated_at DESC
        LIMIT 5
      `),
    ]);

    return NextResponse.json({
      ok: true,
      total_rows: Number(totalRes.rows[0]?.count ?? 0),
      human_touched_rows: Number(humanRes.rows[0]?.count ?? 0),
      by_updated_by: byUserRes.rows.map(r => ({ updated_by: r.updated_by, count: Number(r.count) })),
      recent_human_touched: sampleRes.rows,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
