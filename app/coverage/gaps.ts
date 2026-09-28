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
  /** The assignment owning this run's days, or null when unassigned. */
  assignment: AssignmentRef | null;
};

export type AssignmentRef = {
  id: string;
  assignee: string;
  status: string;
  /** Server-stamped completion time; blank unless status is a new-flow `done`. */
  completedAt: string;
  dateStart: string;
  dateEnd: string;
};

/** The assignment fields the index reads. DraftAssignment satisfies it. */
export type AssignmentLike = {
  id: string;
  ship_id: number;
  ship_mmsi: number;
  date_start: string;
  date_end: string;
  assignee?: string;
  status?: string;
  completed_at?: string;
};

/**
 * Whether an assignment claims its days on /gaps. Cancelled ones were
 * withdrawn. Legacy `done` rows (blank completed_at) are grandfathered: they
 * keep the pre-lifecycle behaviour of not owning their days, so their
 * still-dirty days stay in the Unassigned queue instead of all reopening at
 * launch. An empty status cell reads as "", which means queued.
 */
export function ownsDays(a: Pick<AssignmentLike, "status" | "completed_at">): boolean {
  const status = a.status || "queued";
  if (status === "cancelled") return false;
  if (status === "done" && !a.completed_at) return false;
  return true;
}

/**
 * Ship-day -> owning assignment. Overlapping assignments on one day: the
 * first in sheet order wins. Overlap is a data smell, not a feature.
 */
export function buildAssignmentIndex(
  rows: Row[],
  assignments: AssignmentLike[],
): (rowIdx: number, date: string) => AssignmentRef | null {
  const rowIdxByShipId = new Map<number, number>();
  const rowIdxByMmsi = new Map<number, number>();
  rows.forEach((row, i) => {
    for (const m of row.members) rowIdxByShipId.set(m.id, i);
    if (row.mmsi > 0 && !rowIdxByMmsi.has(row.mmsi)) rowIdxByMmsi.set(row.mmsi, i);
  });

  const byRow = new Map<number, AssignmentRef[]>();
  for (const a of assignments) {
    if (!a.date_start || !a.date_end || !ownsDays(a)) continue;
    // ship_id is authoritative; legacy rows carry 0 and resolve by MMSI.
    const ri = a.ship_id ? rowIdxByShipId.get(a.ship_id) : (a.ship_mmsi ? rowIdxByMmsi.get(a.ship_mmsi) : undefined);
    if (ri === undefined) continue;
    const list = byRow.get(ri) ?? [];
    list.push({
      id: a.id,
      assignee: a.assignee ?? "",
      status: a.status || "queued",
      completedAt: a.completed_at ?? "",
      dateStart: a.date_start,
      dateEnd: a.date_end,
    });
    byRow.set(ri, list);
  }

  return (rowIdx, date) => {
    for (const r of byRow.get(rowIdx) ?? []) if (date >= r.dateStart && date <= r.dateEnd) return r;
    return null;
  };
}

export type RunState = "unassigned" | "active" | "awaiting_snapshot" | "reopened" | "done";

/**
 * Derived lifecycle state — never persisted. `reopened` is an observation,
 * not a verdict: a snapshot that read Postgres after completion still shows
 * the day dirty. It says nothing about why (the fix may not have landed, or
 * ais_silver_summary may refresh behind the cron — that cadence is external
 * and unknown). High only: Blackout has no silver, so it is `done`.
 */
export function runState(run: Pick<GapRun, "assignment" | "classification">, dataAsOf: string): RunState {
  const a = run.assignment;
  if (!a) return "unassigned";
  if (a.status !== "done") return "active";
  // An unparseable completed_at (Sheets reformatting) compares as older.
  const completed = Date.parse(a.completedAt);
  if (!Number.isNaN(completed) && completed > Date.parse(dataAsOf)) return "awaiting_snapshot";
  return run.classification === "high" ? "reopened" : "done";
}

/** The snapshot's data time: data_as_of, or generated_at on older snapshots. */
export function snapshotAsOf(p: { data_as_of?: string; generated_at: string }): string {
  return p.data_as_of || p.generated_at;
}

export type GapView = "unassigned" | "mine" | "reopened" | "all";

export function inView(run: Pick<GapRun, "assignment">, state: RunState, view: GapView, mySlug: string): boolean {
  switch (view) {
    case "unassigned": return state === "unassigned";
    case "mine":       return mySlug !== "" && run.assignment?.assignee === mySlug;
    case "reopened":   return state === "reopened";
    case "all":        return true;
  }
}

export type RunAction = "assign" | "reassign" | "unassign" | "complete" | "reopen";

/** The spec's per-state action table. Every team member gets the same actions. */
export function actionsFor(state: RunState): RunAction[] {
  switch (state) {
    case "unassigned":        return ["assign"];
    case "active":            return ["reassign", "unassign", "complete"];
    case "awaiting_snapshot": return ["reassign", "unassign", "reopen"];
    case "reopened":          return ["reassign", "unassign", "reopen"];
    case "done":              return ["reopen"];
  }
}

/** Inclusive day count of an assignment's full range. */
export function spanDays(ref: Pick<AssignmentRef, "dateStart" | "dateEnd">): number {
  const ms = Date.parse(`${ref.dateEnd}T00:00:00Z`) - Date.parse(`${ref.dateStart}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Days of one assignment that appear in the given runs (the current view). */
export function visibleDays(assignmentId: string, runs: GapRun[]): number {
  let n = 0;
  for (const r of runs) if (r.assignment?.id === assignmentId) n += r.days;
  return n;
}

/**
 * Confirmation for an action. Actions change the WHOLE assignment, and the
 * visible run is often only part of it (date filter, already-clean days,
 * ineligible days, a High/Blackout split), so the text states the full range.
 */
export function confirmText(a: { verb: string; ref: AssignmentRef; visible: number; detail?: string }): string {
  const range = `${a.ref.dateStart} → ${a.ref.dateEnd} (${spanDays(a.ref)} days)`;
  return `${a.verb} ${range}${a.detail ? ` ${a.detail}` : ""}? ${a.visible} of those days are in this view.`;
}

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
  assignmentAt?: (rowIdx: number, date: string) => AssignmentRef | null;
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
      const ref = cls === null ? null : (assignmentAt?.(si, date) ?? null);

      const continues =
        open !== null &&
        cls !== null &&
        open.classification === cls &&
        (open.assignment?.id ?? null) === (ref?.id ?? null) &&
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
        assignment: ref,
      };
      openIdx = d;
    }

    if (open) runs.push(open);
  }

  return runs;
}

/**
 * Newest work first: start date descending, then ship name. High and Blackout
 * render as separate tables, so classification no longer needs a rank here.
 */
export function sortGapRuns(runs: GapRun[]): GapRun[] {
  return [...runs].sort(
    (a, b) =>
      b.dateStart.localeCompare(a.dateStart) ||
      a.shipName.localeCompare(b.shipName),
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
