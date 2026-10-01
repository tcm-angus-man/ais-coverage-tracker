import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { buildSnapshotViaGateway } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-triggered snapshot rebuild — same work as the hourly cron but
// invoked manually by an assigner from the UI. The build itself runs in the
// Cruise Globe Dashboard gateway.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  if (session.user.role !== "assigner") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await buildSnapshotViaGateway();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[snapshot/rebuild] failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
