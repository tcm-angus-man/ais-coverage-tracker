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
 *   review -> high      data exists but is flagged or not visible; the cleaning
 *                       team can work it. This is the operational focus.
 *   none   -> blackout  neither layer holds anything usable. A real coverage
 *                       gap, but not actionable by the team today.
 *   done   -> null      already covered; not gap work.
 *
 * High + Blackout is therefore exactly the Merged tab's unresolved population,
 * because `mergedDayOutcome` is the same function the KPI calls. Blackout alone
 * is smaller than the headline unresolved figure — the rest is High.
 */
export function classifyGapDay(silver: Cell | null, voyage: Cell | null): GapClass | null {
  const outcome = mergedDayOutcome(silver, voyage);
  if (outcome === "review") return "high";
  if (outcome === "none") return "blackout";
  return null;
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
