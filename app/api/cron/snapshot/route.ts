import { NextResponse } from "next/server";
import { buildSnapshot, endPool } from "@/lib/snapshot/build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes; the snapshot has 24+ months of cells

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the env var
// is set in the project settings. We require it in production.
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Local dev: allow without auth header. Refuse in production.
    return process.env.VERCEL_ENV !== "production";
  }
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await buildSnapshot();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[cron/snapshot] failed", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    // Best-effort. The lambda will be torn down anyway, but ending the pool
    // keeps local script runs from leaving open connections.
    await endPool().catch(() => undefined);
  }
}
