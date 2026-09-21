import { describe, expect, it } from "vitest";
import { computeSilverKpis, mergedDayOutcome } from "../../app/coverage/kpis";
import type { Row } from "../../app/coverage/rows";
import type { Cell, Ship } from "../../app/coverage/types";

const ship = (over: Partial<Ship> = {}): Ship => ({
  id: 1, mmsi: 200000001, name: "SHIP", display_name: "Ship", cruise_line: "Line",
  imo_number: "9000001", in_service: true, cruise_type: "Ocean Cruise",
  service_start: null, service_end: null, tier: 2, ...over,
});

const row = (s: Ship): Row => ({ mmsi: s.mmsi, primary: s, members: [s] } as Row);

const clean = (t = 900): Cell => ({ t, v: t, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0, u: 0 });
const dirty = (t = 900): Cell => ({ t, v: 0, na: 0, dw: 0, np: 0, dt: 3, dd: 0, sp: 0, ol: 0, u: 0 });

describe("computeSilverKpis", () => {
  // The bug this function exists to fix: with the window widened to 2015, the
  // old denominator was ships x every date, so a hull built in 2024 was charged
  // for a decade of days it did not exist. Cleanliness must be measured against
  // the data we hold, not against the calendar.
  it("measures cleanliness against days with data, not the whole axis", () => {
    const dates = ["2015-01-01", "2020-01-01", "2024-01-01", "2024-01-02"];
    const rows = [row(ship())];
    // Data on only two of four days: one clean, one dirty.
    const cells: (Cell | null)[][] = [[null, null, clean(), dirty()]];

    const k = computeSilverKpis([0], rows, dates, cells);

    expect(k.withData).toBe(2);
    expect(k.needsReview).toBe(1);
    // 1 clean of 2 days with data. The two empty days must NOT drag this down.
    expect(k.cleanedPct).toBe(50);
  });

  // Pre-service days are the single biggest distortion: they were ~65% of the
  // denominator on the real fleet.
  it("excludes days before a hull entered service from the ingestion rate", () => {
    const dates = ["2015-01-01", "2024-01-01", "2024-01-02", "2024-01-03"];
    const rows = [row(ship({ service_start: "2024-01-01" }))];
    const cells: (Cell | null)[][] = [[null, clean(), clean(), null]];

    const k = computeSilverKpis([0], rows, dates, cells);

    expect(k.inServiceDays).toBe(3);       // 2015 day excluded entirely
    expect(k.ingestedPct).toBe(66.7);      // 2 of 3 in-service days ingested
    expect(k.missing).toBe(1);             // the in-service gap, not the 2015 day
  });

  it("excludes days after a hull left service", () => {
    const dates = ["2024-01-01", "2024-01-02", "2024-01-03"];
    const rows = [row(ship({ service_end: "2024-01-01" }))];
    const cells: (Cell | null)[][] = [[clean(), null, null]];

    const k = computeSilverKpis([0], rows, dates, cells);

    expect(k.inServiceDays).toBe(1);
    expect(k.ingestedPct).toBe(100);
    expect(k.missing).toBe(0);
  });

  // Silver is MMSI-keyed, so a cleaned day still counts even if the hull was
  // out of service that day — but it must not push ingestion past 100%.
  it("counts out-of-service data without letting ingestion exceed 100%", () => {
    const dates = ["2024-01-01", "2024-01-02"];
    const rows = [row(ship({ service_end: "2024-01-01" }))];
    const cells: (Cell | null)[][] = [[clean(), clean()]];

    const k = computeSilverKpis([0], rows, dates, cells);

    expect(k.withData).toBe(2);            // both days' data is real
    expect(k.inServiceDays).toBe(1);
    expect(k.ingestedPct).toBe(100);       // clamped by construction, not by Math.min
  });

  it("treats zero-row_count cells as no data", () => {
    const dates = ["2024-01-01", "2024-01-02"];
    const rows = [row(ship())];
    const cells: (Cell | null)[][] = [[clean(0), clean()]];

    const k = computeSilverKpis([0], rows, dates, cells);

    expect(k.withData).toBe(1);
    expect(k.missing).toBe(1);
  });

  it("reports zero rather than dividing by zero when nothing matches", () => {
    const k = computeSilverKpis([], [], [], []);
    expect(k.cleanedPct).toBe(0);
    expect(k.ingestedPct).toBe(0);
  });

  // Reproduces the shape of the real complaint: 483 ships x 4282 days where
  // only a third of days carry data. Old maths gave 16.7%; the answer to
  // "how clean is our data" is 47.4%.
  it("separates the two questions the old single number conflated", () => {
    const dates = Array.from({ length: 300 }, (_, i) => `2024-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
    const rows = [row(ship())];
    // 100 days of data: 60 clean, 40 dirty. 200 days ingested nothing.
    const cells: (Cell | null)[][] = [dates.map((_, i) => (i >= 200 ? (i < 260 ? clean() : dirty()) : null))];

    const k = computeSilverKpis([0], rows, dates, cells);

    expect(k.withData).toBe(100);
    expect(k.cleanedPct).toBe(60);         // of the data we hold
    expect(k.ingestedPct).toBe(33.3);      // of the hull's in-service life
  });
});

describe("mergedDayOutcome", () => {
  it("prefers the silver verdict when silver has data", () => {
    // Voyage says visible, silver says dirty — silver wins, because silver is
    // the layer that actually measures cleanliness.
    expect(mergedDayOutcome(dirty(), { ...clean(), v: 3, t: 3 })).toBe("review");
    expect(mergedDayOutcome(clean(), null)).toBe("clean");
  });

  it("falls back to voyage coverage where silver has no data", () => {
    expect(mergedDayOutcome(null, { t: 2, v: 2, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 })).toBe("clean");
    expect(mergedDayOutcome(clean(0), { t: 2, v: 2, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 })).toBe("clean");
  });

  it("flags voyage days whose problem counts outweigh visible coverage", () => {
    expect(mergedDayOutcome(null, { t: 2, v: 1, na: 0, dw: 2, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 })).toBe("review");
    expect(mergedDayOutcome(null, { t: 2, v: 1, na: 2, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 })).toBe("review");
  });

  it("reports none only when neither layer covers the day", () => {
    expect(mergedDayOutcome(null, null)).toBe("none");
    expect(mergedDayOutcome(null, { t: 1, v: 0, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 })).toBe("none");
  });
});
