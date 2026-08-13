import { describe, expect, it } from "vitest";
import {
  attributedShips,
  buildRows,
  mergeSilverCells,
  mergeVoyageCells,
  rowInService,
  rowIsOutOfService,
} from "../../app/coverage/rows";
import type { Cell, Ship } from "../../app/coverage/types";

// Synthetic fixtures only — never real snapshot data (.claude/rules/data-privacy.md).
function ship(over: Partial<Ship> & { id: number }): Ship {
  return {
    mmsi: 111,
    name: `SHIP ${over.id}`,
    display_name: `SHIP ${over.id}`,
    cruise_line: "TEST LINE",
    imo_number: "9000000",
    in_service: false,
    cruise_type: null,
    service_start: null,
    service_end: null,
    tier: 4,
    ...over,
  };
}

function cell(over: Partial<Cell>): Cell {
  return { t: 0, v: 0, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0, ...over };
}

describe("buildRows", () => {
  it("collapses two ships sharing an MMSI into one row", () => {
    const braemar = ship({ id: 1, mmsi: 111, display_name: "BRAEMAR" });
    const villa = ship({ id: 2, mmsi: 111, display_name: "VILLA VIE ODYSSEY", in_service: true });
    const rows = buildRows([braemar, villa], {});
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("m:111");
    expect(rows[0].members).toHaveLength(2);
  });

  it("picks the in-service member as primary even when the other has newer data", () => {
    // The retired hull carries the more recent voyage day; in_service must still win,
    // because the flag is the operator's statement of which identity is current.
    const retired = ship({ id: 1, mmsi: 111, display_name: "BRAEMAR" });
    const current = ship({ id: 2, mmsi: 111, display_name: "VILLA VIE ODYSSEY", in_service: true });
    const rows = buildRows([retired, current], {
      "1": { "2026-08-01": cell({ t: 1 }) },
      "2": { "2024-01-01": cell({ t: 1 }) },
    });
    expect(rows[0].primary.display_name).toBe("VILLA VIE ODYSSEY");
  });

  it("falls back to the most recent voyage day when no member is in service", () => {
    const older = ship({ id: 1, mmsi: 111, display_name: "OLD NAME" });
    const newer = ship({ id: 2, mmsi: 111, display_name: "NEW NAME" });
    const rows = buildRows([older, newer], {
      "1": { "2020-01-01": cell({ t: 1 }) },
      "2": { "2023-06-30": cell({ t: 1 }) },
    });
    expect(rows[0].primary.display_name).toBe("NEW NAME");
  });

  it("ignores empty voyage days when ranking members by recency", () => {
    // t === 0 is a rendered-but-empty day; it must not count as activity.
    const real = ship({ id: 1, mmsi: 111, display_name: "REAL" });
    const empty = ship({ id: 2, mmsi: 111, display_name: "EMPTY" });
    const rows = buildRows([real, empty], {
      "1": { "2020-01-01": cell({ t: 2 }) },
      "2": { "2026-01-01": cell({ t: 0 }) },
    });
    expect(rows[0].primary.display_name).toBe("REAL");
  });

  it("keeps ships without an MMSI on their own rows", () => {
    const a = ship({ id: 1, mmsi: 0, display_name: "NO MMSI A" });
    const b = ship({ id: 2, mmsi: 0, display_name: "NO MMSI B" });
    const rows = buildRows([a, b], {});
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.key).sort()).toEqual(["s:1", "s:2"]);
  });
});

describe("mergeVoyageCells", () => {
  it("sums counts across members that both sailed that day", () => {
    const merged = mergeVoyageCells([
      cell({ t: 1, v: 1, na: 0, dw: 0 }),
      cell({ t: 2, v: 1, na: 1, dw: 0 }),
    ]);
    expect(merged).toEqual(expect.objectContaining({ t: 3, v: 2, na: 1, dw: 0 }));
  });

  it("returns null when no member has a cell that day", () => {
    expect(mergeVoyageCells([null, null])).toBeNull();
  });

  it("clears the gap flag when another member covers the day", () => {
    // np means "active range, no voyage". If the sister record has a voyage,
    // the hull was not idle, so the merged row must not read as a gap.
    const merged = mergeVoyageCells([cell({ t: 0, np: 1 }), cell({ t: 1, v: 1 })]);
    expect(merged?.np).toBe(0);
  });

  it("keeps the gap flag when no member covers the day", () => {
    const merged = mergeVoyageCells([cell({ t: 0, np: 1 }), null]);
    expect(merged?.np).toBe(1);
  });
});

describe("mergeSilverCells", () => {
  it("does not double-count identical fanned-out silver rows", () => {
    // build.ts writes each MMSI's silver row to every ship_id sharing it, so
    // summing would report twice the pings that exist.
    const shared = cell({ t: 500, v: 500 });
    expect(mergeSilverCells([shared, shared])?.t).toBe(500);
  });

  it("picks the member cell with the most pings", () => {
    expect(mergeSilverCells([cell({ t: 10 }), cell({ t: 400 })])?.t).toBe(400);
  });
});

describe("rowIsOutOfService", () => {
  const rows = buildRows(
    [
      ship({ id: 1, mmsi: 111, display_name: "BRAEMAR", service_start: "2015-01-01", service_end: "2024-05-31" }),
      ship({ id: 2, mmsi: 111, display_name: "VILLA VIE", service_start: "2024-06-01", service_end: null, in_service: true }),
    ],
    {},
  );

  it("is in service on a day covered by the older member only", () => {
    expect(rowIsOutOfService(rows[0], "2020-03-01")).toBe(false);
  });

  it("is in service on a day covered by the newer member only", () => {
    expect(rowIsOutOfService(rows[0], "2026-01-01")).toBe(false);
  });

  it("is out of service only outside every member's window", () => {
    expect(rowIsOutOfService(rows[0], "2014-01-01")).toBe(true);
  });

  it("reports the row in service when any member is", () => {
    expect(rowInService(rows[0])).toBe(true);
  });
});

describe("attributedShips", () => {
  const braemar = ship({ id: 1, mmsi: 111, display_name: "BRAEMAR" });
  const villa = ship({ id: 2, mmsi: 111, display_name: "VILLA VIE", in_service: true });
  const voyageCells = {
    "1": { "2020-03-01": cell({ t: 1 }), "2024-06-01": cell({ t: 1 }) },
    "2": { "2024-06-01": cell({ t: 1 }), "2026-01-01": cell({ t: 2 }) },
  };
  const rows = buildRows([braemar, villa], voyageCells);

  it("names the single ship that sailed that day", () => {
    expect(attributedShips(rows[0], "2020-03-01", voyageCells).map(s => s.display_name)).toEqual(["BRAEMAR"]);
  });

  it("names both ships when both have data on the same day", () => {
    const names = attributedShips(rows[0], "2024-06-01", voyageCells).map(s => s.display_name);
    expect(names).toHaveLength(2);
    expect(names).toContain("BRAEMAR");
    expect(names).toContain("VILLA VIE");
  });

  it("falls back to every member when no ship has data that day", () => {
    // A blank day cannot be attributed, and showing no name at all reads as a bug.
    expect(attributedShips(rows[0], "2019-01-01", voyageCells)).toHaveLength(2);
  });
});
