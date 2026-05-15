import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { readCoverageBlob } from "@/lib/snapshot/blob";
import { decompressJson } from "@/lib/snapshot/compress";
import { sheetsGet } from "@/lib/sheets/client";
import type { CoveragePayload } from "@/app/coverage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-time helper: emit a CSV keyed by MMSI for the new ship_metadata schema.
// For each ship row in the current snapshot blob, join the existing IMO-keyed
// metadata to inherit tier / service window / cruise_type. The output is
// pasteable straight into the Sheets tab (overwrite the data rows).
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    if (session.user.role !== "assigner") {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const buf = await readCoverageBlob();
    if (!buf) {
      return NextResponse.json({ ok: false, error: "no snapshot blob" }, { status: 500 });
    }
    const payload = await decompressJson<CoveragePayload>(buf);

    // Read the existing IMO-keyed sheet directly (don't go through the typed
    // fetcher, which now expects the new MMSI-keyed schema). Original headers:
    //   ship_name, cruise_line, imo_number, ship_count, cruise_type,
    //   service_start, service_end, tier
    const rows = await sheetsGet("ship_metadata!A1:H");
    const byImo = new Map<string, { cruise_type: string; service_start: string | null; service_end: string | null; tier: number }>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const imo = (r[2] ?? "").trim();
      if (!imo) continue;
      const tier = Number((r[7] ?? "").trim()) || 4;
      byImo.set(imo, {
        cruise_type: (r[4] ?? "").trim(),
        service_start: ((r[5] ?? "").trim() || null),
        service_end:   ((r[6] ?? "").trim() || null),
        tier,
      });
    }

    const header = ["ship_name", "cruise_line", "mmsi", "cruise_type", "service_start", "service_end", "tier"];
    const lines: string[] = [header.join(",")];

    let withMeta = 0, withoutMeta = 0;
    for (const s of payload.ships) {
      const m = s.imo_number ? byImo.get(s.imo_number) : undefined;
      if (m) withMeta++; else withoutMeta++;
      // Strip commas from name/cruise_line to keep the CSV simple. Names with
      // commas are rare in this dataset; this keeps the output trivially
      // pasteable into Sheets without quoting headaches.
      const safe = (v: string) => v.replace(/,/g, " ").trim();
      lines.push([
        safe(s.display_name),
        safe(s.cruise_line),
        String(s.mmsi),
        m?.cruise_type ?? "",
        m?.service_start ?? "",
        m?.service_end ?? "",
        String(m?.tier ?? 4),
      ].join(","));
    }

    const csv = lines.join("\n") + "\n";
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=ship_metadata_mmsi.csv",
        "X-Stats-With-Meta": String(withMeta),
        "X-Stats-Without-Meta": String(withoutMeta),
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
