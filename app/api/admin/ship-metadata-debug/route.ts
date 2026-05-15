import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsGet } from "@/lib/sheets/client";
import { SHIP_METADATA_COLUMNS } from "@/lib/sheets/schemas";
import { fetchShipMetadataUncached } from "@/lib/sheets/ship-metadata";
import { readCoverageBlob } from "@/lib/snapshot/blob";
import { decompressJson } from "@/lib/snapshot/compress";
import type { CoveragePayload } from "@/app/coverage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    if (session.user.role !== "assigner") {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    // Raw read so we can see what Sheets actually returned, including any
    // mangling of the IMO column.
    let rawError: string | null = null;
    let rawRows: string[][] = [];
    try {
      rawRows = await sheetsGet("ship_metadata!A1:H10");
    } catch (e) {
      rawError = e instanceof Error ? e.message : String(e);
    }

    // Run the same parser the snapshot uses.
    let parsedError: string | null = null;
    let parsedCount = 0;
    let parsedSample: unknown[] = [];
    let tierCounts: Record<string, number> = {};
    try {
      const parsed = await fetchShipMetadataUncached();
      parsedCount = parsed.length;
      parsedSample = parsed.slice(0, 5);
      for (const r of parsed) {
        const k = String(r.tier);
        tierCounts[k] = (tierCounts[k] || 0) + 1;
      }
    } catch (e) {
      parsedError = e instanceof Error ? e.message : String(e);
    }

    // Read the live snapshot blob so we can see the IMOs as they currently
    // appear in the served data — and how many of them join successfully.
    let blobError: string | null = null;
    let blobShipCount = 0;
    let blobGeneratedAt: string | null = null;
    let blobTierCounts: Record<string, number> = {};
    let blobImoSample: { mmsi: number; imo_number: string; tier: number; cruise_type: string | null }[] = [];
    let joinMatched = 0;
    let joinMismatched = 0;
    let joinMismatchSample: { display_name: string; mmsi: number }[] = [];
    try {
      const buf = await readCoverageBlob();
      if (!buf) throw new Error("blob not found — cron has not run yet");
      const payload = await decompressJson<CoveragePayload>(buf);
      blobGeneratedAt = payload.generated_at;
      blobShipCount = payload.ships.length;

      // Build the metadata index from the *uncached* fetch result we already have above.
      const metaIndex = new Map<number, unknown>();
      try {
        const parsed = await fetchShipMetadataUncached();
        for (const r of parsed) metaIndex.set(r.mmsi, r);
      } catch { /* surfaced separately above */ }

      for (const s of payload.ships) {
        const tk = String(s.tier);
        blobTierCounts[tk] = (blobTierCounts[tk] || 0) + 1;
        const meta = metaIndex.get(s.mmsi);
        if (meta) joinMatched++; else {
          joinMismatched++;
          if (joinMismatchSample.length < 8) {
            joinMismatchSample.push({ display_name: s.display_name, mmsi: s.mmsi });
          }
        }
      }
      blobImoSample = payload.ships.slice(0, 5).map(s => ({
        mmsi: s.mmsi,
        imo_number: s.imo_number,
        tier: s.tier,
        cruise_type: s.cruise_type,
      }));
    } catch (e) {
      blobError = e instanceof Error ? e.message : String(e);
    }

    return NextResponse.json({
      ok: true,
      expected_header: SHIP_METADATA_COLUMNS,
      sheet_raw: {
        error: rawError,
        row_count_first_page: rawRows.length,
        header_row: rawRows[0] ?? null,
        first_data_rows: rawRows.slice(1, 4),
      },
      sheet_parsed: {
        error: parsedError,
        count: parsedCount,
        tier_counts: tierCounts,
        sample: parsedSample,
      },
      snapshot_blob: {
        error: blobError,
        generated_at: blobGeneratedAt,
        ship_count: blobShipCount,
        tier_counts: blobTierCounts,
        imo_sample: blobImoSample,
        join_matched: joinMatched,
        join_mismatched: joinMismatched,
        join_mismatch_sample: joinMismatchSample,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
