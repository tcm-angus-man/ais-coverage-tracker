import { NextResponse } from "next/server";
import type { CoveragePayload } from "@/app/coverage/types";
import { readCoverageBlob } from "@/lib/snapshot/blob";
import { decompressJson } from "@/lib/snapshot/compress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 1: read brotli-compressed snapshot from Vercel Blob, decompress, return.
// Cache for 1h (matches the cron cadence). If the Blob has never been written
// (cold start before the first cron run), fall through to a tiny fixture in
// non-production so the heatmap still renders. In production, surface a 503
// — per snapshot-conventions.md "Failure mode": stale is fine, missing is not,
// don't synthesise.
export async function GET() {
  try {
    const buf = await readCoverageBlob();
    if (!buf) throw new Error("blob not found — cron has not run yet");
    const payload = await decompressJson<CoveragePayload>(buf);
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        ETag: `"${payload.generated_at}"`,
      },
    });
  } catch (err) {
    if (process.env.VERCEL_ENV === "production") {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("[api/coverage] blob read failed", err);
      return NextResponse.json(
        { ok: false, error: `snapshot unavailable: ${message}` },
        { status: 503 },
      );
    }
    return NextResponse.json(devFallback(), {
      headers: {
        "Cache-Control": "no-store",
        "X-Coverage-Source": "dev-fallback",
      },
    });
  }
}

// Inline fixture used only when running without a populated Blob (local dev
// before the first cron run). Mirrors the four ships from Phase 0 so the
// heatmap renders something.
function devFallback(): CoveragePayload {
  const today = new Date();
  const days = 60;
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const ships = [
    { id: 1, mmsi: 209407000, name: "QUEEN MARY 2", display_name: "Queen Mary 2", cruise_line: "Cunard", imo_number: "9241061", in_service: true },
    { id: 2, mmsi: 311042900, name: "ICON OF THE SEAS", display_name: "Icon of the Seas", cruise_line: "Royal Caribbean", imo_number: "9929420", in_service: true },
    { id: 3, mmsi: 235103245, name: "ANTHEM OF THE SEAS", display_name: "Anthem of the Seas", cruise_line: "Royal Caribbean", imo_number: "9656099", in_service: true },
    { id: 4, mmsi: 232003251, name: "VENTURA", display_name: "Ventura", cruise_line: "P&O Cruises", imo_number: "9333175", in_service: false },
  ];

  const voyage_cells: CoveragePayload["voyage_cells"] = {};
  const silver_cells: CoveragePayload["silver_cells"] = {};
  for (const s of ships) {
    voyage_cells[String(s.mmsi)] = {};
    silver_cells[String(s.mmsi)] = {};
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const seed = (s.mmsi + i * 31) % 17;
      if (seed > 2) {
        const t = (seed * 3) % 25;
        const v = Math.max(0, t - (seed % 5));
        voyage_cells[String(s.mmsi)][d] = { t, v, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 };
      }
      const silverSeed = (s.mmsi + i * 13) % 19;
      if (silverSeed > 5 && i % 2 === 0) {
        const t = (silverSeed * 2) % 20;
        const v = Math.max(0, t - (silverSeed % 4));
        silver_cells[String(s.mmsi)][d] = { t, v, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 };
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    date_range: { start: dates[0], end: dates[dates.length - 1] },
    ships,
    dates,
    voyage_cells,
    silver_cells,
  };
}
