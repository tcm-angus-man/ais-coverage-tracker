import { NextResponse } from "next/server";
import type { CoveragePayload } from "@/app/coverage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 0 fixture. Phase 1 replaces with a streamed read from Vercel Blob
// (`coverage-latest.json`) populated by /api/cron/snapshot.
export async function GET() {
  const today = new Date();
  const days = 60;
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const ships = [
    {
      id: 1,
      mmsi: 209407000,
      name: "QUEEN MARY 2",
      display_name: "Queen Mary 2",
      cruise_line: "Cunard",
      imo_number: "9241061",
      in_service: true,
      imo_siblings: [],
    },
    {
      id: 2,
      mmsi: 311042900,
      name: "ICON OF THE SEAS",
      display_name: "Icon of the Seas",
      cruise_line: "Royal Caribbean",
      imo_number: "9929420",
      in_service: true,
      imo_siblings: [],
    },
    {
      id: 3,
      mmsi: 235103245,
      name: "ANTHEM OF THE SEAS",
      display_name: "Anthem of the Seas",
      cruise_line: "Royal Caribbean",
      imo_number: "9656099",
      in_service: true,
      imo_siblings: [],
    },
    {
      id: 4,
      mmsi: 232003251,
      name: "VENTURA",
      display_name: "Ventura",
      cruise_line: "P&O Cruises",
      imo_number: "9333175",
      in_service: false,
      imo_siblings: [],
    },
  ];

  const voyage_cells: Record<string, Record<string, { t: number; v: number; na: number; dw: number; np: number }>> = {};
  const silver_cells: Record<string, Record<string, { t: number; v: number; na: number; dw: number; np: number }>> = {};

  for (const s of ships) {
    voyage_cells[String(s.mmsi)] = {};
    silver_cells[String(s.mmsi)] = {};
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const seed = (s.mmsi + i * 31) % 17;
      if (seed > 2) {
        const t = (seed * 3) % 25;
        const v = Math.max(0, t - (seed % 5));
        voyage_cells[String(s.mmsi)][d] = { t, v, na: 0, dw: 0, np: 0 };
      }
      const silverSeed = (s.mmsi + i * 13) % 19;
      if (silverSeed > 5 && i % 2 === 0) {
        const t = (silverSeed * 2) % 20;
        const v = Math.max(0, t - (silverSeed % 4));
        silver_cells[String(s.mmsi)][d] = { t, v, na: 0, dw: 0, np: 0 };
      }
    }
  }

  const payload: CoveragePayload = {
    generated_at: new Date().toISOString(),
    date_range: { start: dates[0], end: dates[dates.length - 1] },
    ships,
    dates,
    voyage_cells,
    silver_cells,
  };

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
