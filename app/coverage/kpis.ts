import type { Cell } from "./types";
import type { Row } from "./rows";
import { rowIsOutOfService } from "./rows";

// KPI arithmetic, extracted from CoverageGrid so it can be tested. The grid
// renders these; it doesn't compute them.

const pct1 = (num: number, den: number): number =>
  den === 0 ? 0 : Math.round((num / den) * 1000) / 10;

export type SilverKpis = {
  /** Ship-days with AIS rows, anywhere on the axis. */
  withData: number;
  /** Subset of withData with at least one non-zero anomaly count. */
  needsReview: number;
  /** In-service ship-days we hold no AIS data for — the backfill gap. */
  missing: number;
  /** Denominator for `ingestedPct`: ship-days inside each hull's service window. */
  inServiceDays: number;
  /** Of the data we hold, how much is clean. */
  cleanedPct: number;
  /** Of the fleet's in-service life, how much has been ingested at all. */
  ingestedPct: number;
};

/**
 * Cleanliness KPIs.
 *
 * `cleanedPct` divides by days we actually hold data for, NOT by every day on
 * the axis. Dividing by the axis conflated two questions — "how much AIS data
 * do we have" and "how clean is it" — and once the silver window widened to
 * 2015 it buried the answer to both: every day before a hull was built counted
 * against cleanliness. `ingestedPct` answers the first question on its own.
 *
 * Days outside a hull's [service_start, service_end] window are excluded from
 * the ingestion denominator only. They still count toward `withData` when they
 * carry data, because silver is MMSI-keyed and a cleaned ship-day is a cleaned
 * ship-day regardless of which record claimed the hull that day.
 */
export function computeSilverKpis(
  rowIdxs: number[],
  rows: Row[],
  dates: string[],
  cells: (Cell | null)[][],
): SilverKpis {
  let withData = 0;
  let needsReview = 0;
  let inServiceDays = 0;
  let withDataInService = 0;

  for (const si of rowIdxs) {
    for (let di = 0; di < dates.length; di++) {
      const inService = !rowIsOutOfService(rows[si], dates[di]);
      if (inService) inServiceDays++;

      const cell = cells[si][di];
      if (!cell || cell.t === 0) continue;

      withData++;
      if (inService) withDataInService++;
      if (cell.dt + cell.dd + cell.sp + cell.ol > 0) needsReview++;
    }
  }

  return {
    withData,
    needsReview,
    // Counted against in-service days only, so it can't exceed inServiceDays
    // and the "no data" tile means "gap in the backfill", not "ship not built".
    missing: inServiceDays - withDataInService,
    inServiceDays,
    cleanedPct: pct1(withData - needsReview, withData),
    ingestedPct: pct1(withDataInService, inServiceDays),
  };
}

export type DayOutcome = "clean" | "review" | "none";

/**
 * Merged-tab verdict for one ship-day: take whichever layer carries a cleaned
 * signal for that day. Silver wins where it has data, because it's the layer
 * that actually measures cleanliness; otherwise fall back to voyage coverage.
 *
 * Note this is a coalesce, not a union — a day silver marks dirty stays dirty
 * even if the voyage layer shows it as visible.
 */
export function mergedDayOutcome(silver: Cell | null, voyage: Cell | null): DayOutcome {
  if (silver && silver.t > 0) {
    return silver.dt + silver.dd + silver.sp + silver.ol > 0 ? "review" : "clean";
  }
  if (voyage && voyage.v >= 1) {
    return voyage.dw > voyage.v || voyage.na > voyage.v ? "review" : "clean";
  }
  return "none";
}
