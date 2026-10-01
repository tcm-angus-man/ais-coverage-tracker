import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";
import { memberByUserId } from "@/lib/sheets/team-config";

export const dynamic = "force-dynamic";

type DailyCount = { date: string; count: number };

// GET /api/gateway/ais/progress: this route's response minus display_name and
// slug. The gateway runs the queries (and drops 'data-platform'); the roster
// lives here, so the roster fields are added here.
type GatewayProgress = {
  reviewers: { user_id: string; days_cleaned: number; last_active: string; daily: DailyCount[]; daily30: DailyCount[] }[];
  totals: { total_days: number; clean_days: number };
  recent: { updated_by: string; ship_name: string | null; mmsi: number; date: string; updated_at: string }[];
  today: { user_id: string; count: number; last_updated_at: string }[];
  today_hourly: { user_id: string; hours: number[] }[];
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }

    const { reviewers: reviewerRows, totals, recent: recentRows, today: todayRows, today_hourly: hourlyRows } =
      await gatewayFetch<GatewayProgress>("ais/progress");

    const reviewers = reviewerRows.map(r => {
      const member = memberByUserId(r.user_id);
      return {
        user_id:      r.user_id,
        display_name: member?.display_name ?? `User ${r.user_id}`,
        slug:         member?.slug ?? r.user_id,
        days_cleaned: r.days_cleaned,
        last_active:  r.last_active,
        daily:        r.daily,
        daily30:      r.daily30,
      };
    });

    const recent = recentRows.map(r => {
      const member = memberByUserId(r.updated_by);
      return {
        ...r,
        display_name: member?.display_name ?? `User ${r.updated_by}`,
      };
    });

    const today = todayRows.map(r => {
      const member = memberByUserId(r.user_id);
      return {
        user_id:         r.user_id,
        display_name:    member?.display_name ?? `User ${r.user_id}`,
        count:           r.count,
        last_updated_at: r.last_updated_at,
      };
    });

    const today_hourly = hourlyRows.map(({ user_id, hours }) => {
      const member = memberByUserId(user_id);
      return {
        user_id,
        display_name: member?.display_name ?? `User ${user_id}`,
        slug:         member?.slug ?? user_id,
        hours, // length 24, value at index h = count for that hour
      };
    });

    return NextResponse.json({ ok: true, reviewers, totals, recent, today, today_hourly });

  } catch (err) {
    console.error("[/api/progress]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
