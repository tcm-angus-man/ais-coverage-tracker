import type { Cell } from "./types";
import type { Row } from "./rows";
import { covidWindow, eligibleDayIndices, mergedDayOutcome } from "./kpis";

// The /gaps worklist. Phase 1 covers the two classifications derivable from the
// snapshot as it stands; `nc` / Low (voyage-visible but never manually checked)
// needs a new Cell field and lands in Phase 2.

export type GapClass = "high" | "blackout";

export type GapRun = {
  rowIdx: number;
  mmsi: number;
  /**
   * IMO of the row's primary ship record. Blank when the snapshot has none.
   * Taken from the primary rather than merged across members because a
   * shared-MMSI row can hold two hulls with different IMOs, and the primary is
   * the identity the row is labelled with.
   */
  imo: string;
  shipName: string;
  cruiseLine: string;
  /** Primary ship_id for the row — what an assignment is keyed on. */
  shipId: number;
  dateStart: string;
  dateEnd: string;
  days: number;
  classification: GapClass;
  /** Assignment identity this run sits under, or null when unassigned. */
  assignmentKey: string | null;
};

/**
 * Classify one eligible ship-day, reusing the Merged tab's own verdict.
 *
 * A day the Merged tab counts as done is not gap work. Every unresolved day is
 * then split by the only thing that decides whether the cleaning team can act:
 * **is there silver data to clean?**
 *
 *   silver present -> high      the team can work it. This is the operational
 *                               focus, and the team cleans silver, not voyages.
 *   silver absent  -> blackout  nothing to clean. A real coverage gap worth
 *                               quantifying, but not actionable today.
 *
 * Presence of silver is the whole test, because an unresolved day can never
 * carry CLEAN silver — clean silver makes the day done. So "has silver" and
 * "has dirty silver" are the same condition here.
 *
 * This is why a voyage that exists but is not visible on the globe is NOT High
 * when the silver layer is empty for that ship-day: the Merged view calls it
 * unresolved, but there is no silver for a cleaner to touch. Listing it as
 * actionable put multi-year runs in the queue that nobody could work.
 *
 * High + Blackout remains exactly the Merged tab's unresolved population — the
 * split moved, the total did not.
 */
export function classifyGapDay(silver: Cell | null, voyage: Cell | null): GapClass | null {
  if (mergedDayOutcome(silver, voyage) === "done") return null;
  const silverHasData = silver !== null && silver.t > 0;
  return silverHasData ? "high" : "blackout";
}

/**
 * Free-text ship match for the worklist filter: name, cruise line, IMO or MMSI.
 *
 * Matches against every member of the row, not just the primary, so searching a
 * hull's former name still finds it — the row is an MMSI, and a renamed or
 * resold hull keeps several ship records under it.
 */
export function matchesShipQuery(row: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (String(row.mmsi).includes(q)) return true;
  return row.members.some(s =>
    s.display_name.toLowerCase().includes(q) ||
    s.name.toLowerCase().includes(q) ||
    s.cruise_line.toLowerCase().includes(q) ||
    s.imo_number.toLowerCase().includes(q) ||
    String(s.mmsi).includes(q));
}

export type BuildGapRunsArgs = {
  rowIdxs: number[];
  rows: Row[];
  dates: string[];
  voyageCells: (Cell | null)[][];
  silverCells: (Cell | null)[][];
  /**
   * Assignment identity covering a ship-day, or null. Runs break when this
   * changes so an assigned stretch never merges with an unassigned one.
   */
  assignmentAt?: (rowIdx: number, date: string) => string | null;
  /**
   * Inclusive YYYY-MM-DD bounds. Applied to eligible DAYS before runs are
   * built, so runs clip to the window instead of spilling past it — what you
   * see is what an assignment covers.
   */
  dateFrom?: string;
  dateTo?: string;
};

/**
 * Collapse eligible gap days into contiguous runs.
 *
 * A run continues only while the ship, the classification and the assignment
 * identity all hold AND the day index advances by exactly one. Days excluded
 * by the service window or the COVID rule are absent from the eligible set, so
 * they break continuity — which is correct: a run should not silently span a
 * period we deliberately do not count.
 */
export function buildGapRuns(args: BuildGapRunsArgs): GapRun[] {
  const { rowIdxs, rows, dates, voyageCells, silverCells, assignmentAt, dateFrom, dateTo } = args;
  const w = covidWindow(dates);
  const runs: GapRun[] = [];

  for (const si of rowIdxs) {
    const row = rows[si];
    if (!row) continue;
    const all = eligibleDayIndices(row, dates, voyageCells[si], w).indices;
    const indices = (dateFrom || dateTo)
      ? all.filter(d => (!dateFrom || dates[d] >= dateFrom) && (!dateTo || dates[d] <= dateTo))
      : all;

    let open: GapRun | null = null;
    let openIdx = -1;

    for (const d of indices) {
      const cls = classifyGapDay(silverCells[si][d], voyageCells[si][d]);
      const date = dates[d];
      const key = cls === null ? null : (assignmentAt?.(si, date) ?? null);

      const continues =
        open !== null &&
        cls !== null &&
        open.classification === cls &&
        open.assignmentKey === key &&
        d === openIdx + 1;

      if (continues && open) {
        open.dateEnd = date;
        open.days++;
        openIdx = d;
        continue;
      }

      if (open) { runs.push(open); open = null; }
      if (cls === null) { openIdx = -1; continue; }

      open = {
        rowIdx: si,
        mmsi: row.mmsi,
        imo: row.primary.imo_number,
        shipName: row.primary.display_name || row.primary.name,
        cruiseLine: row.primary.cruise_line,
        shipId: row.primary.id,
        dateStart: date,
        dateEnd: date,
        days: 1,
        classification: cls,
        assignmentKey: key,
      };
      openIdx = d;
    }

    if (open) runs.push(open);
  }

  return runs;
}

/**
 * Operational order: actionable work first, longest run first within it, then
 * ship name. Blackout is not a priority tier — it sorts to the end so it can
 * never be mistaken for the top of the queue.
 */
export function sortGapRuns(runs: GapRun[]): GapRun[] {
  const rank = (c: GapClass) => (c === "high" ? 0 : 1);
  return [...runs].sort(
    (a, b) =>
      rank(a.classification) - rank(b.classification) ||
      b.days - a.days ||
      a.shipName.localeCompare(b.shipName) ||
      a.dateStart.localeCompare(b.dateStart),
  );
}

export type GapTotals = { highDays: number; blackoutDays: number; highRuns: number; blackoutRuns: number };

export function gapTotals(runs: GapRun[]): GapTotals {
  let highDays = 0, blackoutDays = 0, highRuns = 0, blackoutRuns = 0;
  for (const r of runs) {
    if (r.classification === "high") { highDays += r.days; highRuns++; }
    else { blackoutDays += r.days; blackoutRuns++; }
  }
  return { highDays, blackoutDays, highRuns, blackoutRuns };
}
