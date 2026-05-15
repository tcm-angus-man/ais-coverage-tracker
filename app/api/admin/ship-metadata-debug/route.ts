import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsGet } from "@/lib/sheets/client";
import { SHIP_METADATA_COLUMNS } from "@/lib/sheets/schemas";
import { fetchShipMetadataUncached } from "@/lib/sheets/ship-metadata";

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

    return NextResponse.json({
      ok: true,
      expected_header: SHIP_METADATA_COLUMNS,
      raw: {
        error: rawError,
        row_count_first_page: rawRows.length,
        header_row: rawRows[0] ?? null,
        first_data_rows: rawRows.slice(1, 4),
      },
      parsed: {
        error: parsedError,
        count: parsedCount,
        tier_counts: tierCounts,
        sample: parsedSample,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
