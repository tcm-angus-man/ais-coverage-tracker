import { NextResponse } from "next/server";
import { getPool } from "@/lib/snapshot/db";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { memberByUserId } from "@/lib/sheets/team-config";

export const dynamic = "force-dynamic";

const EXCLUDED_USER_IDS = new Set(["data-platform"]);

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }

    const pool = getPool();

    const [reviewersRes, totalRes, recentRes, dailyRes] = await Promise.all([
      pool.query<{ updated_by: string; days_cleaned: string; last_active: string }>(`
        SELECT
          updated_by,
          COUNT(*)              AS days_cleaned,
          MAX(updated_at)::date::text AS last_active
        FROM ais_silver_summary
        WHERE updated_by IS NOT NULL
          AND updated_by NOT IN ('data-platform')
          AND delta_time_count      = 0
          AND delta_distance_count  = 0
          AND spike_count           = 0
          AND overland_count        = 0
        GROUP BY updated_by
        ORDER BY days_cleaned DESC
      `),

      pool.query<{ total_days: string; clean_days: string }>(`
        SELECT
          COUNT(*)                                    AS total_days,
          COUNT(*) FILTER (
            WHERE delta_time_count     = 0
              AND delta_distance_count = 0
              AND spike_count          = 0
              AND overland_count       = 0
          )                                           AS clean_days
        FROM ais_silver_summary
      `),

      pool.query<{ updated_by: string; ship_name: string | null; mmsi: number; date: string; updated_at: string }>(`
        SELECT
          s.updated_by,
          sh.display_name AS ship_name,
          s.mmsi,
          s.date::text,
          s.updated_at::text
        FROM ais_silver_summary s
        LEFT JOIN ships sh ON sh.mmsi = s.mmsi
        WHERE s.updated_by IS NOT NULL
          AND s.updated_by NOT IN ('data-platform')
          AND s.delta_time_count      = 0
          AND s.delta_distance_count  = 0
          AND s.spike_count           = 0
          AND s.overland_count        = 0
        ORDER BY s.updated_at DESC
        LIMIT 50
      `),

      pool.query<{ updated_by: string; date: string; count: string }>(`
        SELECT
          updated_by,
          date::text,
          COUNT(*) AS count
        FROM ais_silver_summary
        WHERE updated_by IS NOT NULL
          AND updated_by NOT IN ('data-platform')
          AND date >= CURRENT_DATE - INTERVAL '60 days'
          AND delta_time_count      = 0
          AND delta_distance_count  = 0
          AND spike_count           = 0
          AND overland_count        = 0
        GROUP BY updated_by, date
        ORDER BY date ASC
      `),
    ]);

    const dailyByReviewer = new Map<string, { date: string; count: number }[]>();
    for (const row of dailyRes.rows) {
      if (!dailyByReviewer.has(row.updated_by)) dailyByReviewer.set(row.updated_by, []);
      dailyByReviewer.get(row.updated_by)!.push({ date: row.date, count: Number(row.count) });
    }

    const reviewers = reviewersRes.rows
      .filter(r => !EXCLUDED_USER_IDS.has(r.updated_by))
      .map(r => {
        const member = memberByUserId(r.updated_by);
        return {
          user_id:      r.updated_by,
          display_name: member?.display_name ?? `User ${r.updated_by}`,
          slug:         member?.slug ?? r.updated_by,
          days_cleaned: Number(r.days_cleaned),
          last_active:  r.last_active,
          daily:        dailyByReviewer.get(r.updated_by) ?? [],
        };
      });

    const recent = recentRes.rows
      .filter(r => !EXCLUDED_USER_IDS.has(r.updated_by))
      .map(r => {
        const member = memberByUserId(r.updated_by);
        return {
          ...r,
          display_name: member?.display_name ?? `User ${r.updated_by}`,
        };
      });

    const totals = {
      total_days: Number(totalRes.rows[0]?.total_days ?? 0),
      clean_days: Number(totalRes.rows[0]?.clean_days ?? 0),
    };

    return NextResponse.json({ ok: true, reviewers, totals, recent });

  } catch (err) {
    console.error("[/api/progress]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
