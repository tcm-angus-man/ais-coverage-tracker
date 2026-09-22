import { describe, expect, it } from "vitest";
import { buildGapRuns, classifyGapDay, gapTotals, matchesShipQuery, sortGapRuns } from "../../app/coverage/gaps";
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
    expect(runs.every(r => r.days === 2)).toBe(true);
  });

  it("splits a run when the assignment identity changes", () => {
    const runs = buildGapRuns({
      ...base([review(), review(), review(), review()], [silverBad(), silverBad(), silverBad(), silverBad()]),
      assignmentAt: (_r, date) => (date <= "2024-01-02" ? "kim|in_progress" : null),
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ days: 2, assignmentKey: "kim|in_progress" });
    expect(runs[1]).toMatchObject({ days: 2, assignmentKey: null });
  });
});

describe("sortGapRuns", () => {
  it("puts actionable High work first, longest run first, and Blackout last", () => {
    const runs = buildGapRuns({
      rowIdxs: [0],
      rows: [row(ship())],
      dates: days(8),
      //       blackout x2         high x3 (dirty silver)          high x1
      voyageCells: [[nothing(), nothing(), review(), review(), review(), done(), review(), done()]],
      silverCells: [[null, null, silverBad(), silverBad(), silverBad(), null, silverBad(), null]],
    });
    const sorted = sortGapRuns(runs);
    expect(sorted.map(r => `${r.classification}:${r.days}`)).toEqual(["high:3", "high:1", "blackout:2"]);
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
