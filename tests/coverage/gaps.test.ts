import { describe, expect, it } from "vitest";
import {
  actionsFor, buildAssignmentIndex, buildGapRuns, classifyGapDay, confirmText, gapTotals, inView,
  matchesShipQuery, ownsDays, runState, snapshotAsOf, sortGapRuns, spanDays, visibleDays,
  type AssignmentLike, type AssignmentRef, type GapRun,
} from "../../app/coverage/gaps";
import { covidWindow, eligibleDayIndices, mergedDayOutcome } from "../../app/coverage/kpis";
import type { Row } from "../../app/coverage/rows";
import type { Cell, Ship } from "../../app/coverage/types";

const ship = (over: Partial<Ship> = {}): Ship => ({
  id: 1, mmsi: 200000001, name: "SHIP A", display_name: "Ship A", cruise_line: "Line",
  imo_number: "9000001", in_service: true, cruise_type: "Ocean Cruise",
  service_start: null, service_end: null, tier: 2, ...over,
});

const row = (s: Ship): Row => ({ key: `m:${s.mmsi}`, mmsi: s.mmsi, primary: s, members: [s] });

// Day shapes, named for the merged verdict they produce.
const done      = (): Cell => ({ t: 1, v: 1, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 });
const review    = (): Cell => ({ t: 1, v: 0, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 });
const silverBad = (): Cell => ({ t: 900, v: 0, na: 0, dw: 0, np: 0, dt: 4, dd: 0, sp: 0, ol: 0, u: 0 });
const silverEmpty = (): Cell => ({ t: 0, v: 0, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0, u: 0 });
const nothing   = (): null => null;

const days = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `2024-01-${String(from + i).padStart(2, "0")}`);

describe("classifyGapDay", () => {
  // The team cleans silver, so actionable work requires silver data to clean.
  it("maps an unresolved day WITH silver data to High", () => {
    expect(classifyGapDay(silverBad(), null)).toBe("high");
    expect(classifyGapDay(silverBad(), review())).toBe("high");
  });

  it("maps an unresolved day with no silver data to Blackout", () => {
    expect(classifyGapDay(null, null)).toBe("blackout");
  });

  // Regression: PIANO LAND surfaced a 1,127-day High run over a period with no
  // silver layer at all. A voyage that exists but is not visible on the globe
  // is unresolved in the Merged view, but there is nothing for a cleaner to
  // touch, so it must not be queued as actionable work.
  it("does not call a not-visible voyage High when silver is empty", () => {
    expect(classifyGapDay(null, review())).toBe("blackout");
    expect(classifyGapDay(silverEmpty(), review())).toBe("blackout");
  });

  it("excludes completed days from the worklist entirely", () => {
    expect(classifyGapDay(null, done())).toBeNull();
    expect(classifyGapDay(silverBad(), done())).toBeNull();
  });
});

describe("buildGapRuns", () => {
  const base = (cells: (Cell | null)[], silver?: (Cell | null)[]) => ({
    rowIdxs: [0],
    rows: [row(ship())],
    dates: days(cells.length),
    voyageCells: [cells],
    silverCells: [silver ?? cells.map(() => null)],
  });

  it("merges adjacent days of the same classification into one run", () => {
    const runs = buildGapRuns(base([review(), review(), review()], [silverBad(), silverBad(), silverBad()]));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ classification: "high", dateStart: "2024-01-01", dateEnd: "2024-01-03", days: 3 });
  });

  it("splits a run when the classification changes", () => {
    // Two cleanable days (dirty silver), then two with no silver to clean.
    const runs = buildGapRuns(base(
      [review(), review(), nothing(), nothing()],
      [silverBad(), silverBad(), null, null],
    ));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ classification: "high", days: 2 });
    expect(runs[1]).toMatchObject({ classification: "blackout", days: 2, dateStart: "2024-01-03" });
  });

  it("splits a run when a completed day interrupts it", () => {
    const runs = buildGapRuns(base([review(), done(), review()], [silverBad(), null, silverBad()]));
    expect(runs).toHaveLength(2);
    expect(runs.every(r => r.days === 1)).toBe(true);
    expect(runs[1].dateStart).toBe("2024-01-03");
  });

  // Out-of-service days are absent from the eligible set, so they must break
  // continuity rather than being silently spanned.
  it("ignores days outside the service window and breaks runs across them", () => {
    const s = ship({ service_start: "2024-01-03" });
    const runs = buildGapRuns({
      rowIdxs: [0],
      rows: [row(s)],
      dates: days(4),
      voyageCells: [[review(), review(), review(), review()]],
      silverCells: [[silverBad(), silverBad(), silverBad(), silverBad()]],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ classification: "high", dateStart: "2024-01-03", dateEnd: "2024-01-04", days: 2 });
  });

  // A non-visible COVID day with no qualifying run is excluded from the
  // denominator, so it must not appear as gap work either.
  it("ignores COVID days the Merged KPI excludes", () => {
    const dates = ["2020-06-01", "2020-06-02", "2020-06-03"];
    const runs = buildGapRuns({
      rowIdxs: [0],
      rows: [row(ship())],
      dates,
      voyageCells: [[review(), review(), review()]],
      silverCells: [[null, null, null]],
    });
    expect(runs).toHaveLength(0);
  });

  it("never merges different ships into one run", () => {
    const a = ship({ id: 1, mmsi: 111, display_name: "Alpha" });
    const b = ship({ id: 2, mmsi: 222, display_name: "Bravo" });
    const runs = buildGapRuns({
      rowIdxs: [0, 1],
      rows: [row(a), row(b)],
      dates: days(2),
      voyageCells: [[review(), review()], [review(), review()]],
      silverCells: [[silverBad(), silverBad()], [silverBad(), silverBad()]],
    });
    expect(runs).toHaveLength(2);
    expect(runs.map(r => r.mmsi).sort()).toEqual([111, 222]);
    // Identity columns come from the row's primary record.
    expect(runs.every(r => r.imo === "9000001")).toBe(true);
    expect(runs.every(r => r.days === 2)).toBe(true);
  });

  it("splits a run when the assignment identity changes", () => {
    const kim: AssignmentRef = { id: "a1", assignee: "kim", status: "in_progress", completedAt: "", dateStart: "2024-01-01", dateEnd: "2024-01-02" };
    const runs = buildGapRuns({
      ...base([review(), review(), review(), review()], [silverBad(), silverBad(), silverBad(), silverBad()]),
      assignmentAt: (_r, date) => (date <= "2024-01-02" ? kim : null),
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ days: 2, assignment: { id: "a1" } });
    expect(runs[1]).toMatchObject({ days: 2, assignment: null });
  });
});

describe("sortGapRuns", () => {
  // The team works the most recent gaps first, so the worklist reads newest
  // dateStart first — not longest first, which buried recent work under old
  // multi-year runs.
  it("orders runs by start date, newest first, regardless of length", () => {
    const runs = buildGapRuns({
      rowIdxs: [0],
      rows: [row(ship())],
      dates: days(8),
      //       high x3 (from 01-01)                   done    high x1 (01-05)  done   high x2 (01-07)
      voyageCells: [[review(), review(), review(), done(), review(), done(), review(), review()]],
      silverCells: [[silverBad(), silverBad(), silverBad(), null, silverBad(), null, silverBad(), silverBad()]],
    });
    const sorted = sortGapRuns(runs);
    expect(sorted.map(r => `${r.dateStart}:${r.days}`)).toEqual([
      "2024-01-07:2", "2024-01-05:1", "2024-01-01:3",
    ]);
  });

  it("breaks a start-date tie by ship name", () => {
    const a = ship({ id: 1, mmsi: 200000001, display_name: "Zeta" });
    const b = ship({ id: 2, mmsi: 200000002, display_name: "Alpha" });
    const runs = buildGapRuns({
      rowIdxs: [0, 1],
      rows: [row(a), row(b)],
      dates: days(1),
      voyageCells: [[review()], [review()]],
      silverCells: [[silverBad()], [silverBad()]],
    });
    expect(sortGapRuns(runs).map(r => r.shipName)).toEqual(["Alpha", "Zeta"]);
  });
});

// The acceptance condition: the worklist must account for exactly the Merged
// tab's unresolved population — no day dropped by run-building, none counted
// twice. Merged counts `review` into needsReview and `none` into missing, so
// unresolved = needsReview + missing. Requiring silver data for High moved the
// split between the two bands; it must not have changed the total.
describe("reconciliation with the Merged unresolved population", () => {
  it("High days + Blackout days equal the merged unresolved total", () => {
    const dates = ["2020-06-01", "2020-06-02", "2021-05-05", ...days(28)];
    const ships = [
      ship({ id: 1, mmsi: 111, display_name: "Alpha" }),
      ship({ id: 2, mmsi: 222, display_name: "Bravo", service_start: "2024-01-10" }),
      ship({ id: 3, mmsi: 333, display_name: "Charlie", service_end: "2024-01-20" }),
    ];
    const rows = ships.map(row);
    const pick = (i: number, seed: number): Cell | null => {
      const m = (i * 7 + seed * 13) % 5;
      if (m === 0) return null;
      if (m === 1 || m === 2) return review();
      return done();
    };
    const voyageCells = ships.map((_, s) => dates.map((_, i) => pick(i, s)));
    const silverCells = ships.map((_, s) => dates.map((_, i) => ((i + s) % 4 === 0 ? silverBad() : null)));
    const rowIdxs = [0, 1, 2];

    // Merged KPI's own counting, over the same eligible set.
    const w = covidWindow(dates);
    let unresolved = 0, withSilver = 0, withoutSilver = 0;
    for (const si of rowIdxs) {
      const { indices } = eligibleDayIndices(rows[si], dates, voyageCells[si], w);
      for (const d of indices) {
        if (mergedDayOutcome(silverCells[si][d], voyageCells[si][d]) === "done") continue;
        unresolved++;
        const sc = silverCells[si][d];
        if (sc && sc.t > 0) withSilver++; else withoutSilver++;
      }
    }

    const runs = buildGapRuns({ rowIdxs, rows, dates, voyageCells, silverCells });
    const totals = gapTotals(runs);

    expect(totals.highDays + totals.blackoutDays).toBe(unresolved);
    expect(totals.highDays).toBe(withSilver);
    expect(totals.blackoutDays).toBe(withoutSilver);

    // Guard against a fixture that would pass trivially.
    expect(withSilver).toBeGreaterThan(0);
    expect(withoutSilver).toBeGreaterThan(0);
  });

  // The bug in one assertion: nothing in the actionable band may lack silver.
  it("never puts a day with no silver data into High", () => {
    const dates = days(20);
    const rows = [row(ship())];
    // Every day has a voyage that is requested but not visible, and no silver.
    const voyageCells = [dates.map(() => review())];
    const silverCells = [dates.map(() => null)];

    const runs = buildGapRuns({ rowIdxs: [0], rows, dates, voyageCells, silverCells });

    expect(runs.every(r => r.classification === "blackout")).toBe(true);
    expect(gapTotals(runs).highDays).toBe(0);
    expect(gapTotals(runs).blackoutDays).toBe(20);
  });
});

describe("matchesShipQuery", () => {
  const multi = (): Row => {
    const now = ship({ id: 2, mmsi: 311042900, display_name: "Villa Vie Odyssey", name: "VILLA VIE ODYSSEY", cruise_line: "Villa Vie", imo_number: "9210218" });
    const was = ship({ id: 3, mmsi: 311042900, display_name: "Braemar", name: "BRAEMAR", cruise_line: "Fred Olsen", imo_number: "9210218" });
    return { key: "m:311042900", mmsi: 311042900, primary: now, members: [now, was] };
  };

  it("matches on ship name, case-insensitively and on partials", () => {
    expect(matchesShipQuery(multi(), "villa")).toBe(true);
    expect(matchesShipQuery(multi(), "ODYSSEY")).toBe(true);
    expect(matchesShipQuery(multi(), "zzz")).toBe(false);
  });

  it("matches on cruise line", () => {
    expect(matchesShipQuery(multi(), "fred olsen")).toBe(true);
  });

  it("matches on IMO and MMSI", () => {
    expect(matchesShipQuery(multi(), "9210218")).toBe(true);
    expect(matchesShipQuery(multi(), "311042900")).toBe(true);
    expect(matchesShipQuery(multi(), "3110429")).toBe(true);
  });

  // The row is an MMSI, so a hull's former name must still find it — otherwise
  // searching a resold ship by the name on an old assignment returns nothing.
  it("matches a former name on a shared-MMSI row", () => {
    expect(matchesShipQuery(multi(), "braemar")).toBe(true);
  });

  it("treats an empty or whitespace query as no filter", () => {
    expect(matchesShipQuery(multi(), "")).toBe(true);
    expect(matchesShipQuery(multi(), "   ")).toBe(true);
  });
});

describe("date range", () => {
  const args = () => ({
    rowIdxs: [0],
    rows: [row(ship())],
    dates: days(10),
    voyageCells: [Array(10).fill(null).map(() => review())],
    silverCells: [Array(10).fill(null).map(() => silverBad())],
  });

  // Clipping, not overlap-filtering: an assignment created from a visible run
  // must cover exactly the days shown, never days outside the chosen window.
  it("clips runs to the window rather than returning whole overlapping runs", () => {
    const runs = buildGapRuns({ ...args(), dateFrom: "2024-01-03", dateTo: "2024-01-05" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ dateStart: "2024-01-03", dateEnd: "2024-01-05", days: 3 });
  });

  it("accepts an open-ended range on either side", () => {
    expect(buildGapRuns({ ...args(), dateFrom: "2024-01-08" })[0]).toMatchObject({ dateStart: "2024-01-08", days: 3 });
    expect(buildGapRuns({ ...args(), dateTo: "2024-01-02" })[0]).toMatchObject({ dateEnd: "2024-01-02", days: 2 });
  });

  it("returns nothing when the window excludes every eligible day", () => {
    expect(buildGapRuns({ ...args(), dateFrom: "2025-01-01" })).toHaveLength(0);
  });

  it("is a no-op when no bounds are given", () => {
    expect(buildGapRuns(args())[0].days).toBe(10);
  });
});

const assignment = (over: Partial<AssignmentLike> = {}): AssignmentLike => ({
  id: "a1", ship_id: 1, ship_mmsi: 200000001, date_start: "2024-01-01", date_end: "2024-01-04",
  assignee: "nick", status: "queued", completed_at: "", ...over,
});
const ref = (over: Partial<AssignmentRef> = {}): AssignmentRef => ({
  id: "a1", assignee: "nick", status: "queued", completedAt: "", dateStart: "2024-01-01", dateEnd: "2024-01-04", ...over,
});
const runWith = (a: AssignmentRef | null, classification: "high" | "blackout" = "high") =>
  ({ assignment: a, classification }) as Pick<GapRun, "assignment" | "classification">;
const SNAP = "2026-09-28T10:00:00.000Z";

describe("ownsDays", () => {
  it("claims days for live statuses and new-flow done", () => {
    expect(ownsDays({ status: "queued" })).toBe(true);
    expect(ownsDays({ status: "blocked" })).toBe(true);
    expect(ownsDays({ status: "done", completed_at: "2026-09-28T09:00:00.000Z" })).toBe(true);
  });

  // Cancelled = withdrawn; its days go back to the pool.
  it("releases a cancelled assignment's days", () => {
    expect(ownsDays({ status: "cancelled" })).toBe(false);
  });

  // The grandfathering guarantee: legacy done rows behave exactly as today,
  // so their still-dirty days stay in the Unassigned queue at launch.
  it("releases a legacy done assignment (blank completed_at)", () => {
    expect(ownsDays({ status: "done", completed_at: "" })).toBe(false);
    expect(ownsDays({ status: "done" })).toBe(false);
  });

  // Review focus 5: an empty status cell is "", not undefined.
  it("treats a blank status cell as queued", () => {
    expect(ownsDays({ status: "" })).toBe(true);
  });
});

describe("buildAssignmentIndex", () => {
  const rows = [row(ship())];

  it("resolves a day inside an assignment to its ref", () => {
    const at = buildAssignmentIndex(rows, [assignment()]);
    expect(at(0, "2024-01-02")).toMatchObject({ id: "a1", assignee: "nick", status: "queued" });
    expect(at(0, "2024-01-05")).toBeNull();
  });

  it("normalises a blank status to queued", () => {
    expect(buildAssignmentIndex(rows, [assignment({ status: "" })])(0, "2024-01-01")?.status).toBe("queued");
  });

  it("skips cancelled and legacy done assignments", () => {
    const at = buildAssignmentIndex(rows, [
      assignment({ id: "c", status: "cancelled" }),
      assignment({ id: "l", status: "done", completed_at: "" }),
    ]);
    expect(at(0, "2024-01-01")).toBeNull();
  });

  // The reappear bug: a completed assignment must keep owning its days.
  it("keeps a new-flow done assignment owning its days", () => {
    const at = buildAssignmentIndex(rows, [assignment({ status: "done", completed_at: SNAP })]);
    expect(at(0, "2024-01-01")?.id).toBe("a1");
  });

  it("gives an overlapping day to the first assignment in sheet order", () => {
    const at = buildAssignmentIndex(rows, [assignment({ id: "first" }), assignment({ id: "second" })]);
    expect(at(0, "2024-01-02")?.id).toBe("first");
  });

  it("ignores an assignment for a ship not in the snapshot", () => {
    const at = buildAssignmentIndex(rows, [assignment({ ship_id: 999, ship_mmsi: 999 })]);
    expect(at(0, "2024-01-01")).toBeNull();
  });
});

describe("buildGapRuns with assignment identity", () => {
  // Decision 3: two adjacent assignments with the same assignee and status
  // must stay two runs, or an action on one would silently hit the other.
  it("never merges adjacent assignments with the same assignee and status", () => {
    const at = buildAssignmentIndex([row(ship())], [
      assignment({ id: "x", date_start: "2024-01-01", date_end: "2024-01-02" }),
      assignment({ id: "y", date_start: "2024-01-03", date_end: "2024-01-04" }),
    ]);
    const runs = buildGapRuns({
      rowIdxs: [0], rows: [row(ship())], dates: days(4),
      voyageCells: [[review(), review(), review(), review()]],
      silverCells: [[silverBad(), silverBad(), silverBad(), silverBad()]],
      assignmentAt: at,
    });
    expect(runs.map(r => r.assignment?.id)).toEqual(["x", "y"]);
  });
});

describe("runState", () => {
  it("is unassigned without an assignment", () => {
    expect(runState(runWith(null), SNAP)).toBe("unassigned");
  });

  it("is active for queued, in_progress and blocked", () => {
    for (const status of ["queued", "in_progress", "blocked"]) {
      expect(runState(runWith(ref({ status })), SNAP)).toBe("active");
    }
  });

  // Completed after the snapshot read Postgres: the snapshot cannot know yet.
  it("is awaiting_snapshot when completed after data_as_of", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "2026-09-28T10:30:00.000Z" })), SNAP)).toBe("awaiting_snapshot");
  });

  // A snapshot taken after completion still shows this High day dirty.
  it("is reopened when completed before data_as_of and still High", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "2026-09-28T09:00:00.000Z" })), SNAP)).toBe("reopened");
  });

  // Blackout has no silver to clean, so it can never be "still dirty".
  it("is done, never reopened, for Blackout under a done assignment", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "2026-09-28T09:00:00.000Z" }), "blackout"), SNAP)).toBe("done");
  });

  // Review focus 2: Sheets can reformat a timestamp into something unparseable.
  it("treats an unparseable completed_at as older than the snapshot", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "28/09/2026 10:30" })), SNAP)).toBe("reopened");
  });
});

describe("snapshotAsOf", () => {
  it("prefers data_as_of", () => {
    expect(snapshotAsOf({ data_as_of: "2026-09-28T10:00:00.000Z", generated_at: "2026-09-28T10:04:00.000Z" })).toBe("2026-09-28T10:00:00.000Z");
  });

  // Review focus 3: snapshots written before data_as_of existed.
  it("falls back to generated_at on an older snapshot", () => {
    expect(snapshotAsOf({ generated_at: "2026-09-28T10:04:00.000Z" })).toBe("2026-09-28T10:04:00.000Z");
  });
});

describe("inView", () => {
  const mine = runWith(ref({ assignee: "kim" }));
  it("Unassigned shows only unassigned runs", () => {
    expect(inView(runWith(null), "unassigned", "unassigned", "kim")).toBe(true);
    expect(inView(mine, "active", "unassigned", "kim")).toBe(false);
  });
  it("My work shows runs assigned to the viewer, in any state", () => {
    expect(inView(mine, "reopened", "mine", "kim")).toBe(true);
    expect(inView(mine, "active", "mine", "nick")).toBe(false);
    expect(inView(runWith(null), "unassigned", "mine", "")).toBe(false);
  });
  it("Reopened shows only reopened runs", () => {
    expect(inView(mine, "reopened", "reopened", "kim")).toBe(true);
    expect(inView(mine, "awaiting_snapshot", "reopened", "kim")).toBe(false);
  });
  it("All shows everything", () => {
    expect(inView(runWith(null), "unassigned", "all", "")).toBe(true);
  });
});

describe("actionsFor", () => {
  // The spec's per-state action table.
  it("matches the lifecycle table", () => {
    expect(actionsFor("unassigned")).toEqual(["assign"]);
    expect(actionsFor("active")).toEqual(["reassign", "unassign", "complete"]);
    expect(actionsFor("awaiting_snapshot")).toEqual(["reassign", "unassign", "reopen"]);
    expect(actionsFor("reopened")).toEqual(["reassign", "unassign", "reopen"]);
    expect(actionsFor("done")).toEqual(["reopen"]);
  });

  // Awaiting runs must not be assignable — that is what stops the double-assign.
  it("never offers assign on a run that already has an assignment", () => {
    for (const s of ["active", "awaiting_snapshot", "reopened", "done"] as const) {
      expect(actionsFor(s)).not.toContain("assign");
    }
  });
});

describe("full-assignment confirmation", () => {
  it("counts the inclusive span of the whole assignment", () => {
    expect(spanDays({ dateStart: "2024-01-01", dateEnd: "2024-06-30" })).toBe(182);
    expect(spanDays({ dateStart: "2024-01-01", dateEnd: "2024-01-01" })).toBe(1);
  });

  it("counts only the visible days belonging to that assignment", () => {
    const runs = [
      { assignment: ref({ id: "a1" }), days: 3 },
      { assignment: ref({ id: "a1" }), days: 2 },
      { assignment: ref({ id: "b2" }), days: 9 },
      { assignment: null, days: 4 },
    ] as GapRun[];
    expect(visibleDays("a1", runs)).toBe(5);
  });

  // Actions change the WHOLE assignment; the text must say so even when the
  // clicked run is a small part of it.
  it("states the full range, the change, and how much of it is in view", () => {
    expect(confirmText({
      verb: "Reassign", ref: ref({ dateStart: "2024-01-01", dateEnd: "2024-06-30" }), visible: 41, detail: "from Nick to Kim",
    })).toBe("Reassign 2024-01-01 → 2024-06-30 (182 days) from Nick to Kim? 41 of those days are in this view.");
  });
});
