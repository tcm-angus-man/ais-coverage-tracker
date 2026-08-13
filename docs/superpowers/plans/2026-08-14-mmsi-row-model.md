# One Row Per MMSI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the coverage and cleanliness heatmaps to one row per MMSI, labelled with the vessel's current name, with the hover naming the ship(s) that actually had data on the hovered day.

**Architecture:** The snapshot payload is unchanged — it stays keyed by `ships.id`, which is what makes per-day attribution possible at all. A new pure module `app/coverage/rows.ts` groups `payload.ships` by MMSI and merges cells; `CoverageGrid.tsx` renders those rows instead of raw ships. Row index remains the coordinate that filters, sorts, canvas draw, hit-test and KPIs all speak.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, React 18, Canvas 2D, Vitest 2.1.

**Spec:** `docs/superpowers/specs/2026-08-14-mmsi-row-model-design.md`

## Global Constraints

- TypeScript strict. No `any`, no implicit any, no untyped function args (`.claude/rules/code-style.md`).
- `app/coverage/` was previously frozen legacy code. It is explicitly in scope for this plan; nothing else in `app/coverage/` may be reformatted or refactored beyond what these tasks name (`.claude/rules/code-style.md`, CLAUDE.md Rule 3).
- **The payload shape must not change.** `app/api/admin/ship-metadata-debug/route.ts`, `app/api/admin/ship-metadata-rekey/route.ts` and `app/api/coverage/route.ts` read `CoveragePayload`; `app/coverage/types.ts` is not edited by any task here.
- **No `@/*` imports in `app/coverage/rows.ts` or its test.** There is no `vitest.config.ts` in this repo, so the `@/*` path alias from `tsconfig.json` does not resolve under Vitest. Use relative imports (`./types`, `../../app/coverage/rows`).
- All test fixtures are synthetic and hand-written. Never paste production rows, snapshot contents, or sheet contents into a test (`.claude/rules/data-privacy.md`).
- Test command is `npx vitest run <path>` for a single file, `npm run test` for all. There are currently **zero** test files in the repo; Task 1 adds the first one.
- Verification commands: `npm run typecheck`, `npm run lint`, `npm run build`.

---

### Task 1: Pure row model and cell merging

Creates the whole row model as a standalone tested module. Nothing renders differently yet — this task is pure logic plus its tests.

**Files:**
- Create: `app/coverage/rows.ts`
- Create: `tests/coverage/rows.test.ts`

**Interfaces:**
- Consumes: `Cell`, `CoveragePayload`, `Ship` from `app/coverage/types.ts` (unchanged).
- Produces, all imported by Task 2 onward:
  - `type Row = { key: string; mmsi: number; primary: Ship; members: Ship[] }`
  - `buildRows(ships: Ship[], voyageCells: CoveragePayload["voyage_cells"]): Row[]`
  - `mergeVoyageCells(cells: (Cell | null)[]): Cell | null`
  - `mergeSilverCells(cells: (Cell | null)[]): Cell | null`
  - `shipIsOutOfService(ship: Ship, date: string): boolean`
  - `rowIsOutOfService(row: Row, date: string): boolean`
  - `rowInService(row: Row): boolean`
  - `attributedShips(row: Row, date: string, voyageCells: CoveragePayload["voyage_cells"]): Ship[]`

- [ ] **Step 1: Write the failing test**

Create `tests/coverage/rows.test.ts`:

```ts
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
    id: over.id,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/coverage/rows.test.ts`
Expected: FAIL — `Failed to resolve import "../../app/coverage/rows"`.

- [ ] **Step 3: Write the implementation**

Create `app/coverage/rows.ts`:

```ts
import type { Cell, CoveragePayload, Ship } from "./types";

// One heatmap row = one MMSI = one physical hull. A hull that was renamed or
// resold keeps its AIS MMSI but gains a second `ships` row in Postgres, so the
// grid groups those records together and renders the current identity.
//
// The snapshot payload stays keyed by ships.id on purpose: per-day attribution
// ("which name did this day belong to?") is only answerable while the member
// cells are still separate. See
// docs/superpowers/specs/2026-08-14-mmsi-row-model-design.md.
export type Row = {
  /** `m:${mmsi}`, or `s:${id}` for ships with no MMSI so they never merge. */
  key: string;
  mmsi: number;
  /** The identity shown in the left column. */
  primary: Ship;
  /** Every ship record on this MMSI, primary first. */
  members: Ship[];
};

/** Latest day this ship has a voyage cell with t > 0, or "" when it has none. */
function lastVoyageDay(shipId: number, voyageCells: CoveragePayload["voyage_cells"]): string {
  const byDate = voyageCells[String(shipId)];
  if (!byDate) return "";
  let last = "";
  for (const d in byDate) {
    if (byDate[d].t > 0 && d > last) last = d;
  }
  return last;
}

// Primary = in_service first, then the most recent day with a voyage, then name.
// Voyage cells break the tie rather than silver because build.ts fans one silver
// row out to every member identically, so silver cannot separate them.
function orderMembers(members: Ship[], voyageCells: CoveragePayload["voyage_cells"]): Ship[] {
  const lastDay = new Map<number, string>();
  for (const s of members) lastDay.set(s.id, lastVoyageDay(s.id, voyageCells));
  return [...members].sort((a, b) => {
    if (a.in_service !== b.in_service) return a.in_service ? -1 : 1;
    const la = lastDay.get(a.id) ?? "";
    const lb = lastDay.get(b.id) ?? "";
    if (la !== lb) return la < lb ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });
}

export function buildRows(
  ships: Ship[],
  voyageCells: CoveragePayload["voyage_cells"],
): Row[] {
  const groups = new Map<string, Ship[]>();
  for (const s of ships) {
    const key = s.mmsi && s.mmsi > 0 ? `m:${s.mmsi}` : `s:${s.id}`;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const rows: Row[] = [];
  for (const [key, members] of groups) {
    const ordered = members.length === 1 ? members : orderMembers(members, voyageCells);
    rows.push({ key, mmsi: ordered[0].mmsi, primary: ordered[0], members: ordered });
  }
  return rows;
}

// Members own disjoint voyages (voyages.ship_id), so a day on which two members
// each have a voyage genuinely carries two voyages for the hull — sum them.
export function mergeVoyageCells(cells: (Cell | null)[]): Cell | null {
  let present = false;
  let t = 0, v = 0, na = 0, dw = 0;
  let gap = false;
  for (const c of cells) {
    if (!c) continue;
    present = true;
    t += c.t;
    v += c.v;
    na += c.na;
    dw += c.dw;
    if (c.np > 0) gap = true;
  }
  if (!present) return null;
  return { t, v, na, dw, np: t === 0 && gap ? 1 : 0, dt: 0, dd: 0, sp: 0, ol: 0 };
}

// Silver is MMSI-keyed and build.ts writes it identically to every member, so
// summing would double-count. Take the richest cell, matching what the silver
// KPI merge already did before rows existed.
export function mergeSilverCells(cells: (Cell | null)[]): Cell | null {
  let best: Cell | null = null;
  for (const c of cells) {
    if (c && (best === null || c.t > best.t)) best = c;
  }
  return best;
}

// Blank service_start = "active before the voyage window"; blank service_end =
// "still in service". String comparison is safe because dates are YYYY-MM-DD.
export function shipIsOutOfService(ship: Ship, date: string): boolean {
  if (ship.service_start && date < ship.service_start) return true;
  if (ship.service_end && date > ship.service_end) return true;
  return false;
}

/** A row is out of service only on days outside every member's window. */
export function rowIsOutOfService(row: Row, date: string): boolean {
  return row.members.every(s => shipIsOutOfService(s, date));
}

export function rowInService(row: Row): boolean {
  return row.members.some(s => s.in_service);
}

/**
 * The ship name(s) a given day belongs to: members with a voyage that day.
 * Falls back to every member when the day has no voyage at all, because a
 * tooltip with no name reads as a bug rather than as an absence of data.
 */
export function attributedShips(
  row: Row,
  date: string,
  voyageCells: CoveragePayload["voyage_cells"],
): Ship[] {
  if (row.members.length === 1) return row.members;
  const owners = row.members.filter(s => (voyageCells[String(s.id)]?.[date]?.t ?? 0) > 0);
  return owners.length > 0 ? owners : row.members;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/coverage/rows.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/coverage/rows.ts tests/coverage/rows.test.ts
git commit -m "feat(coverage): add pure MMSI row model and cell merging"
```

---

### Task 2: Render one row per MMSI

Switches `indexPayload` and the component body from ships to rows. After this task the grid visibly shows one row per MMSI with the current name in the left column. Coverage %, filters, hover and assignments still read the primary member only — Tasks 3–6 fix each in turn.

**Files:**
- Modify: `app/coverage/CoverageGrid.tsx` (`indexPayload` ~117-145; `Indexed` type ~105-115; component body destructure ~221; loops at ~325, ~371, ~406, ~445, ~482-486, ~573, ~665, ~795, ~857, ~875)
- Test: none (canvas rendering is not tested per `.claude/rules/testing.md`; the logic under it is covered by Task 1)

**Interfaces:**
- Consumes: `Row`, `buildRows`, `mergeVoyageCells`, `mergeSilverCells` from Task 1.
- Produces: `Indexed.rows: Row[]`, `Indexed.silverRowSet: Set<number>` (row **indices**, not ship ids) for Tasks 3–6. `LayerMeta.cells[rowIdx][dateIdx]` now holds merged cells.

**Critical:** do **not** introduce a local `ships` binding in the component body. Removing the name is what makes the compiler point at all ~15 call sites; a surviving `ships` array would let `ships[shipIdx]` — where `shipIdx` is now a row index — typecheck while silently reading the wrong vessel. `indexPayload` keeps its own local `ships` from `payload.ships`, which is correct there.

- [ ] **Step 1: Add the import**

In `app/coverage/CoverageGrid.tsx`, after the existing `import { useAssignments } from "./AssignmentContext";` (line 14):

```ts
import {
  buildRows,
  mergeSilverCells,
  mergeVoyageCells,
  type Row,
} from "./rows";
```

- [ ] **Step 2: Replace the `Indexed` type and `indexPayload`**

Replace lines 105-145 (`type Indexed` through the end of `indexPayload`) with:

```ts
type Indexed = {
  payload: CoveragePayload;
  rows: Row[];
  dates: string[];
  silverDates: string[];
  silverDateOffset: number;
  voyage: LayerMeta;
  silver: LayerMeta;
  /** Row indices that have silver data on at least one member. */
  silverRowSet: Set<number>;
  cruiseLineList: string[];
};

function indexPayload(payload: CoveragePayload): Indexed {
  const { ships, dates } = payload;
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdx.set(dates[i], i);

  // One row per MMSI. The payload stays ship_id-keyed so per-day attribution
  // survives; merging happens here.
  const rows = buildRows(ships, payload.voyage_cells);

  const silverShipIds = new Set<number>(Object.keys(payload.silver_cells).map(Number));
  const silverRowSet = new Set<number>();
  rows.forEach((row, i) => {
    if (row.members.some(s => silverShipIds.has(s.id))) silverRowSet.add(i);
  });

  const buildLayer = (
    layer: Record<string, Record<string, Cell>>,
    merge: (cells: (Cell | null)[]) => Cell | null,
  ): LayerMeta => {
    const cells: (Cell | null)[][] = [];
    for (const row of rows) {
      const arr: (Cell | null)[] = new Array(dates.length).fill(null);
      const memberRows = row.members
        .map(s => layer[String(s.id)])
        .filter((r): r is Record<string, Cell> => Boolean(r));
      if (memberRows.length === 1) {
        // Single member — no merge cost on the overwhelmingly common path.
        for (const d in memberRows[0]) {
          const i = dateIdx.get(d);
          if (i !== undefined) arr[i] = memberRows[0][d];
        }
      } else if (memberRows.length > 1) {
        const touched = new Set<number>();
        for (const m of memberRows) {
          for (const d in m) {
            const i = dateIdx.get(d);
            if (i !== undefined) touched.add(i);
          }
        }
        for (const i of touched) {
          const d = dates[i];
          arr[i] = merge(memberRows.map(m => m[d] ?? null));
        }
      }
      cells.push(arr);
    }
    return { cells };
  };

  const SILVER_START = "2025-07-01";
  const silverDateOffset = Math.max(0, dates.findIndex(d => d >= SILVER_START));
  const silverDates = dates.slice(silverDateOffset);

  const clSet = new Set<string>();
  for (const s of ships) if (s.cruise_line) clSet.add(s.cruise_line);
  const cruiseLineList = Array.from(clSet).sort();

  return {
    payload,
    rows,
    dates,
    silverDates,
    silverDateOffset,
    voyage: buildLayer(payload.voyage_cells, mergeVoyageCells),
    silver: buildLayer(payload.silver_cells, mergeSilverCells),
    silverRowSet,
    cruiseLineList,
  };
}
```

- [ ] **Step 3: Run typecheck to enumerate the call sites**

Run: `npm run typecheck`
Expected: FAIL with roughly a dozen `Cannot find name 'ships'` / `Property 'ships' does not exist` errors in `CoverageGrid.tsx`. This error list is the worklist for Step 4.

- [ ] **Step 4: Update the component body**

In the destructure at ~line 221, replace `ships` with `rows` and `silverShipSet` with `silverRowSet`:

```ts
const { rows, dates, silverDates, silverDateOffset, voyage, silver, silverRowSet, cruiseLineList } = indexed;
```

Then apply these replacements. Everything indexed by `i`, `si`, or `shipIdx` is a **row index** from here on.

`shipIdByMmsi` (~256-262) — still reads the raw ship list, so point it at the payload:

```ts
  const shipIdByMmsi = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of payload.ships) {
      if (!m.has(s.mmsi)) m.set(s.mmsi, s.id);
    }
    return m;
  }, [payload]);
```

`shipCoverage` (~322-389) — both loop bounds and the ship lookup:
- `for (let i = 0; i < ships.length; i++)` → `for (let i = 0; i < rows.length; i++)` (both branches, ~325 and ~371)
- `const ship = ships[i];` (~372) → `const ship = rows[i].primary;`
- dependency array (~389): `ships` → `rows`

`covidExcludedByShip` (~396-441):
- `for (let i = 0; i < ships.length; i++)` (~406) → `for (let i = 0; i < rows.length; i++)`
- `const ship = ships[i];` (~431) → `const ship = rows[i].primary;`
- dependency array (~441): `ships` → `rows`

`baseShipIdx` (~444-489):
- `let idxs = ships.map((_, i) => i).filter(i => {` → `let idxs = rows.map((_, i) => i).filter(i => {`
- `const s = ships[i];` → `const s = rows[i].primary;`
- `if (isSilver && !silverShipSet.has(s.id)) return false;` → `if (isSilver && !silverRowSet.has(i)) return false;`
- sort comparators (~482-486): `ships[a].imo_number` → `rows[a].primary.imo_number`, `ships[b].imo_number` → `rows[b].primary.imo_number`, and the same `ships[x].cruise_line` / `ships[x].display_name` → `rows[x].primary.…`
- dependency array (~489): `ships` → `rows`, `silverShipSet` → `silverRowSet`

`silverGroups` (~495-505) — `const ship = ships[si];` → `const ship = rows[si].primary;`. (Task 3 deletes this memo outright; this keeps the tree compiling in the meantime.)

`kpis` (~572-573): `const ship = ships[si];` → `const ship = rows[si].primary;`; dependency array (~595): `ships` → `rows`.

Canvas cell draw (~664-665):
```ts
      const shipIdx = baseShipIdx[r];
      const ship = rows[shipIdx].primary;
```

Assignment dot (~702): `assignedCells.get(\`${ships[shipIdx].id}|${dates[di]}\`)` → `assignedCells.get(\`${rows[shipIdx].primary.id}|${dates[di]}\`)`.

Left header draw (~794-795):
```ts
      const shipIdx = baseShipIdx[r];
      const ship = rows[shipIdx].primary;
```

`onMouseMove` (~857): `const ship = ships[hit.shipIdx];` → `const ship = rows[hit.shipIdx].primary;`; dependency array (~867): `ships` → `rows`.

`onMouseUp` (~874-875): `const ship = ships[shipIdx];` → `const ship = rows[shipIdx].primary;`; dependency array (~894): `ships` → `rows`.

- [ ] **Step 5: Verify it compiles and the row logic still passes**

Run: `npm run typecheck && npx vitest run tests/coverage/rows.test.ts`
Expected: typecheck exits 0 with no output; 18 tests pass.

- [ ] **Step 6: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000/coverage`.
Expected: the ships KPI reads lower than before (distinct MMSIs, not ship records); a hull that previously appeared twice under two names now appears once under its current name; the heatmap for that row shows the older ship's history and the newer ship's history on the same line.

- [ ] **Step 7: Commit**

```bash
git add app/coverage/CoverageGrid.tsx
git commit -m "feat(coverage): render one heatmap row per MMSI"
```

---

### Task 3: Union service window and merged KPIs

The row's coverage % and its out-of-service shading currently follow the primary member's window alone, so a merged row hides the retired identity's active years behind grey hatching. This task moves both to the union rule and drops the now-redundant silver grouping.

**Files:**
- Modify: `app/coverage/CoverageGrid.tsx` (delete `isOutOfService` ~156-163; `shipCoverage` ~322-389; `covidExcludedByShip` ~396-441; delete `silverGroups` ~491-505; `kpis` ~507-595; cell draw ~677)
- Test: none beyond Task 1's `rowIsOutOfService` coverage

**Interfaces:**
- Consumes: `rowIsOutOfService` from Task 1; `rows` from Task 2.
- Produces: nothing new; `silverGroups` ceases to exist and no later task may reference it.

- [ ] **Step 1: Extend the import**

Add `rowIsOutOfService` and `shipIsOutOfService` to the `./rows` import added in Task 2:

```ts
import {
  buildRows,
  mergeSilverCells,
  mergeVoyageCells,
  rowIsOutOfService,
  shipIsOutOfService,
  type Row,
} from "./rows";
```

- [ ] **Step 2: Delete the local `isOutOfService`**

Delete lines 156-163 entirely (the `isOutOfService` function and its comment). It now lives in `rows.ts` as `shipIsOutOfService`. `HoverTooltip` still calls `isOutOfService` and will break; Step 3 patches it, Task 5 rewrites it properly.

- [ ] **Step 3: Point every caller at the row-level check**

- `shipCoverage` voyage branch (~376): `if (isOutOfService(ship, dates[d])) continue;` → `if (rowIsOutOfService(rows[i], dates[d])) continue;`, and delete the now-unused `const ship = rows[i].primary;` on ~372 (the COVID helper does not use it).
- `covidExcludedByShip` (~433): `if (isOutOfService(ship, dates[d])) continue;` → `if (rowIsOutOfService(rows[i], dates[d])) continue;`, and delete `const ship = rows[i].primary;` on ~431.
- `kpis` voyage branch (~577): `if (isOutOfService(ship, dates[d])) { oosExcluded++; continue; }` → `if (rowIsOutOfService(rows[si], dates[d])) { oosExcluded++; continue; }`, and delete `const ship = rows[si].primary;` on ~573.
- Cell draw (~677): `if (mode !== "silver" && cellDate && isOutOfService(ship, cellDate))` → `if (mode !== "silver" && cellDate && rowIsOutOfService(rows[shipIdx], cellDate))`, and delete `const ship = rows[shipIdx].primary;` on ~665. That binding is used nowhere else in the cell-draw loop (everything below it keys off `shipIdx`), so leaving it in fails `npm run lint` as an unused variable.
- `HoverTooltip` (~1355): `{mode !== "silver" && isOutOfService(ship, date) ? (` → `{mode !== "silver" && shipIsOutOfService(ship, date) ? (` — a temporary shim so the file compiles; Task 5 replaces this component's whole ship model.

- [ ] **Step 4: Delete `silverGroups` and simplify the silver KPI**

Delete the `silverGroups` memo (lines ~491-505 including its comment block). Rows are the MMSI groups now, so the grouping is redundant.

Replace the silver branch of `kpis` (the `if (isSilver) { … }` block, ~509-530) with:

```ts
    if (isSilver) {
      // Rows are already one-per-MMSI and their silver cells are merged, so the
      // old per-group merge here is gone. Out-of-service days are still counted:
      // cleanliness is MMSI-keyed and every cleaned ship-day counts.
      let withData = 0, needsReview = 0, missing = 0;
      for (const si of baseShipIdx) {
        for (let di = silverDateOffset; di < dates.length; di++) {
          const cell = silver.cells[si][di];
          if (!cell || cell.t === 0) { missing++; continue; }
          withData++;
          if ((cell.dt + cell.dd + cell.sp + cell.ol) > 0) needsReview++;
        }
      }
      const cleanDays = withData - needsReview;
      const totalDays = withData + missing;
      const pct = totalDays === 0 ? 0 : Math.round((cleanDays / totalDays) * 1000) / 10;
      return { ships: baseShipIdx.length, dates: silverDates.length, pct, label: "cleaned", withData, needsReview, missing };
    } else {
```

Update the `kpis` dependency array (~595) to drop `silverGroups`:

```ts
  }, [isSilver, baseShipIdx, silverDateOffset, dates, silver, voyage, silverDates, rows]);
```

- [ ] **Step 5: Update the two stale comments that describe the old model**

- Above `shipCoverage` (~316-321), replace "Per-ship coverage %" with "Per-row (per-MMSI) coverage %" and note that out-of-service days are excluded on the union of the row's members' windows.
- Above the voyage `kpis` loop (~568-570), replace the "Voyage counts per ship_id row independently — non-overlapping service windows…" comment with: "Voyage counts per MMSI row. A day inside any member's service window enters the denominator and counts as covered when any member has a visible voyage, so a hull's days are counted once regardless of how many ship records it has."

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npx vitest run tests/coverage/rows.test.ts`
Expected: typecheck exits 0; 18 tests pass.

- [ ] **Step 7: Verify in the browser**

Run: `npm run dev`, open `/coverage`.
Expected: on a merged row, the retired identity's years are no longer hatched out-of-service, and the row's % reflects both identities' history. Check the cleanliness tab too — its % should be unchanged from before this task, since silver cells were already MMSI-deduped.

- [ ] **Step 8: Commit**

```bash
git add app/coverage/CoverageGrid.tsx
git commit -m "feat(coverage): union service window and per-MMSI KPIs"
```

---

### Task 4: Filter and sort across all members

A merged row currently matches filters only through its primary member, so searching for the retired name loses the row that holds that ship's history.

**Files:**
- Modify: `app/coverage/CoverageGrid.tsx` (`baseShipIdx` ~444-489; left header draw ~799 and ~816)
- Test: none (predicate changes are directly observable in the UI)

**Interfaces:**
- Consumes: `rowInService` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Extend the import**

Add `rowInService` to the `./rows` import.

- [ ] **Step 2: Match filters against any member**

Replace the filter predicate inside `baseShipIdx` (the `let idxs = rows.map(...)` block) with:

```ts
    // A row is one hull with possibly several ship records. Match on ANY member
    // so a row never vanishes because the current identity alone failed the
    // predicate — searching a retired name must still find the hull.
    let idxs = rows.map((_, i) => i).filter(i => {
      const row = rows[i];
      if (isSilver && !silverRowSet.has(i)) return false;
      if (inServiceOnly && !rowInService(row)) return false;
      if (selectedTiers.size > 0 && !row.members.some(s => selectedTiers.has(s.tier))) return false;
      if (selectedLines.size > 0 && !row.members.some(s => selectedLines.has(s.cruise_line))) return false;
      if (filteredAssigneeShipIds && !row.members.some(s => filteredAssigneeShipIds.has(s.id))) return false;
      if (filter.trim()) {
        const q = filter.toLowerCase();
        if (String(row.mmsi).includes(q)) return true;
        return row.members.some(s =>
          s.display_name.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.cruise_line.toLowerCase().includes(q));
      }
      return true;
    });
```

- [ ] **Step 3: Grey the row only when no member is in service**

In the left header draw loop, replace both uses of `ship.in_service` (~799 and ~816):

```ts
      const inService = rowInService(rows[shipIdx]);
```

declared next to `const ship = rows[shipIdx].primary;`, then `ctx.fillStyle = inService ? C_INK : C_INK_FAINT;` (~799) and `ctx.fillStyle = inService ? C_INK_DIM : C_INK_FAINT;` (~816).

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Verify in the browser**

Run: `npm run dev`, open `/coverage`.
Expected: typing a retired ship's name into the filter box still surfaces the merged row (labelled with the current name); a merged row where either member is in service renders its name in full-brightness ink.

- [ ] **Step 6: Commit**

```bash
git add app/coverage/CoverageGrid.tsx
git commit -m "feat(coverage): match heatmap filters against every member of a row"
```

---

### Task 5: Name the right ship on hover

This is the headline ask: hovering a day names the ship that day belonged to, and names both when two ships have data on the same day.

**Files:**
- Modify: `app/coverage/CoverageGrid.tsx` (`TooltipState` ~199; `onMouseMove` ~854-867; `HoverTooltip` ~1324-1375)
- Test: none (`attributedShips` is covered by Task 1)

**Interfaces:**
- Consumes: `attributedShips`, `rowIsOutOfService`, `Row` from Tasks 1-2.
- Produces: `TooltipState` now carries `row: Row` and `owners: Ship[]` instead of `ship: Ship`.

- [ ] **Step 1: Fix up the import**

Add `attributedShips` to the `./rows` import, and **remove `shipIsOutOfService`** — Step 4 replaces its only remaining caller (the Task 3 shim in `HoverTooltip`) with `rowIsOutOfService`, so leaving it imported fails `npm run lint`. The import should end up as:

```ts
import {
  attributedShips,
  buildRows,
  mergeSilverCells,
  mergeVoyageCells,
  rowInService,
  rowIsOutOfService,
  type Row,
} from "./rows";
```

- [ ] **Step 2: Widen `TooltipState`**

Replace line ~199:

```ts
type TooltipState = { x: number; y: number; row: Row; owners: Ship[]; date: string; voyage?: Cell; silver?: Cell; assignment?: AssignmentInfo } | null;
```

- [ ] **Step 3: Resolve the owners on hover**

Replace the body of `onMouseMove` (~854-867) with:

```ts
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(e);
    if (!hit) { setTooltip(null); return; }
    const row = rows[hit.shipIdx];
    const date = dates[hit.dateIdx];
    // Cleanliness is MMSI-keyed and identical across members, so there is no
    // per-day owner to resolve there — list every name on the hull instead.
    const owners = mode === "silver" ? row.members : attributedShips(row, date, payload.voyage_cells);
    // Read the merged layers, not the raw payload, so the tooltip agrees with
    // the cell that was drawn.
    const v = voyage.cells[hit.shipIdx][hit.dateIdx] ?? undefined;
    const s = silver.cells[hit.shipIdx][hit.dateIdx] ?? undefined;
    const assignment = assignedCells.get(`${row.primary.id}|${date}`);
    setTooltip({ x: e.clientX, y: e.clientY, row, owners, date, voyage: v, silver: s, assignment });
    if (isDragging.current && mode === "silver") {
      setDrag(prev => prev ? { ...prev, r1: hit.r, c1: hit.c } : prev);
      setRenderTick(n => (n + 1) | 0);
    }
  }, [hitTest, rows, dates, payload, mode, assignedCells, voyage, silver]);
```

- [ ] **Step 4: Render the attribution line**

Replace the head of `HoverTooltip` (~1324-1356) — its signature, header block and out-of-service branch — with:

```ts
function HoverTooltip({ tooltip, mode }: { tooltip: NonNullable<TooltipState>; mode: ShellMode }) {
  const { x, y, row, owners, date, voyage, silver, assignment } = tooltip;
  const ship = row.primary;
  const assigneeColor = assignment
    ? (ASSIGNEE_COLOR[assignment.assignee] ?? ASSIGNEE_COLOR_DEFAULT)
    : null;
  // On a merged row, name the ship(s) this day actually belongs to. Suppressed
  // on single-record hulls, where it would only repeat the header.
  const showOwners = row.members.length > 1;
  const ownerNames = owners.map(s => s.display_name).join(" · ");
  // Members can carry different IMOs; surface any that differ from the primary's.
  const otherImos = Array.from(new Set(
    row.members.map(s => s.imo_number).filter(imo => imo && imo !== ship.imo_number),
  ));
  return (
    <div style={{
      position: "fixed", zIndex: 50, pointerEvents: "none",
      background: C_PANEL, border: `1px solid ${C_LINE}`,
      borderRadius: 4, padding: "10px 14px", fontSize: 11, color: C_INK,
      boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
      maxWidth: 280, whiteSpace: "nowrap",
      left: x + 14, top: y - 8,
      transform: [
        x > window.innerWidth - 300 ? "translateX(calc(-100% - 28px))" : "",
        y > window.innerHeight - 200 ? "translateY(-100%)" : "",
      ].filter(Boolean).join(" ") || undefined,
    }}>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>{ship.display_name}</div>
        {showOwners && (
          <div style={{ fontSize: 10, color: C_INK_DIM, marginTop: 2 }}>
            {mode === "silver" ? "shares MMSI: " : "this day: "}{ownerNames}
          </div>
        )}
        <div style={{ fontSize: 9.5, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
          IMO {ship.imo_number}{otherImos.length > 0 ? ` / ${otherImos.join(" / ")}` : ""} · MMSI {ship.mmsi}
        </div>
        {(ship.cruise_type || ship.service_start || ship.service_end) && (
          <div style={{ fontSize: 9.5, color: C_INK_FAINT, marginTop: 2 }}>
            {ship.cruise_type ? `${ship.cruise_type} · ` : ""}T{ship.tier}
            {(ship.service_start || ship.service_end) ? ` · ${ship.service_start ?? "—"} → ${ship.service_end ?? "present"}` : ""}
          </div>
        )}
        <div style={{ fontSize: 10, color: C_INK_DIM, marginTop: 2 }}>{date}</div>
      </div>
      {mode !== "silver" && rowIsOutOfService(row, date) ? (
```

The rest of the component (the voyage/silver sub-tooltips and the assignment footer, ~1357-1375) is unchanged.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint`
Expected: typecheck exits 0; lint exits 0.

- [ ] **Step 6: Verify in the browser**

Run: `npm run dev`, open `/coverage` and find a merged row (filter by a known renamed hull).
Expected:
- Hovering a day in the retired identity's era shows the retired name on the "this day:" line while the header keeps the current name.
- Hovering a day in the current era shows the current name.
- Hovering a changeover day where both records have voyages shows both names separated by `·`.
- Hovering a single-record ship shows no extra line at all.
- On the cleanliness tab, the line reads "shares MMSI:" and lists every name.

- [ ] **Step 7: Commit**

```bash
git add app/coverage/CoverageGrid.tsx
git commit -m "feat(coverage): name the ship a hovered day belongs to"
```

---

### Task 6: Keep assignments attached to the merged row

Assignments are stored against a `ship_id`. After merging, an assignment written against the retired record must still appear on the hull's single row, and new assignments must be written against the current identity.

**Files:**
- Modify: `app/coverage/CoverageGrid.tsx` (`shipIdByMmsi` ~256-262; `assignedCells` ~264-292; `filteredAssigneeShipIds` ~305-314; `baseShipIdx` assignee predicate; assignment dot draw ~702; `onMouseUp` ~869-894; `onMouseMove` assignment lookup; `assignModal`/`editModal` state ~240-241 and usage ~1037-1078)
- Test: none (Sheets round-trip is out of scope per `.claude/rules/testing.md`)

**Interfaces:**
- Consumes: `rows` from Task 2.
- Produces: `assignedCells` is keyed `"${rowIdx}|${date}"` — a **row index**, no longer a ship id. Any later reader must use the row index.

- [ ] **Step 1: Replace the MMSI lookup with row lookups**

Replace `shipIdByMmsi` (~251-262) with:

```ts
  // Assignments carry a ship_id (authoritative) or, on legacy rows, only an
  // MMSI. Both resolve to a row index, so an assignment written against a
  // superseded ship record still lands on the hull's single row.
  const rowIdxByShipId = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((row, i) => { for (const s of row.members) m.set(s.id, i); });
    return m;
  }, [rows]);

  const rowIdxByMmsi = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((row, i) => { if (row.mmsi > 0 && !m.has(row.mmsi)) m.set(row.mmsi, i); });
    return m;
  }, [rows]);
```

- [ ] **Step 2: Key `assignedCells` by row index**

In `assignedCells` (~264-292), replace the resolution and the map key:

```ts
      // `ship_id` is 0 on legacy sheet rows, never undefined — DraftAssignment
      // declares it as a required number, so an `!== undefined` test would be a
      // TS2367 "no overlap" error. Truthiness is both correct and what the
      // existing code used.
      const rowIdx = a.ship_id
        ? rowIdxByShipId.get(a.ship_id)
        : (a.ship_mmsi ? rowIdxByMmsi.get(a.ship_mmsi) : undefined);
      if (rowIdx === undefined) continue;
```

and

```ts
        map.set(`${rowIdx}|${d.toISOString().slice(0, 10)}`, { assignee, status, id: a.id, notes: a.notes, dateStart: a.date_start, dateEnd: a.date_end });
```

Update the comment above the memo to say the key is `"rowIdx|YYYY-MM-DD"`, and the dependency array to `[assignments, silverDates, rowIdxByShipId, rowIdxByMmsi]`.

- [ ] **Step 3: Convert the assignee filter to row indices**

Replace `filteredAssigneeShipIds` (~303-314) with:

```ts
  // Row indices with at least one active assignment for the selected assignee.
  const filteredAssigneeRowIdx = useMemo(() => {
    if (!assigneeFilter) return null;
    const idx = new Set<number>();
    for (const a of assignments) {
      if ((a.assignee ?? "") !== assigneeFilter || a.status === "done") continue;
      // `ship_id` is 0 on legacy sheet rows, never undefined — DraftAssignment
      // declares it as a required number, so an `!== undefined` test would be a
      // TS2367 "no overlap" error. Truthiness is both correct and what the
      // existing code used.
      const rowIdx = a.ship_id
        ? rowIdxByShipId.get(a.ship_id)
        : (a.ship_mmsi ? rowIdxByMmsi.get(a.ship_mmsi) : undefined);
      if (rowIdx !== undefined) idx.add(rowIdx);
    }
    return idx;
  }, [assigneeFilter, assignments, rowIdxByShipId, rowIdxByMmsi]);
```

In `baseShipIdx`, replace the Task 4 line
`if (filteredAssigneeShipIds && !row.members.some(s => filteredAssigneeShipIds.has(s.id))) return false;`
with
`if (filteredAssigneeRowIdx && !filteredAssigneeRowIdx.has(i)) return false;`
and swap `filteredAssigneeShipIds` for `filteredAssigneeRowIdx` in its dependency array.

- [ ] **Step 4: Update the three assignment lookups to use row index**

- Assignment dot draw (~702): `const info = assignedCells.get(\`${rows[shipIdx].primary.id}|${dates[di]}\`);` → `const info = assignedCells.get(\`${shipIdx}|${dates[di]}\`);`
- `onMouseMove` (Task 5's line): `const assignment = assignedCells.get(\`${row.primary.id}|${date}\`);` → `const assignment = assignedCells.get(\`${hit.shipIdx}|${date}\`);`
- `onMouseUp` (~884): `const existing = isSingleCell ? assignedCells.get(\`${ship.id}|${dateStart}\`) : undefined;` → `const existing = isSingleCell ? assignedCells.get(\`${shipIdx}|${dateStart}\`) : undefined;`

- [ ] **Step 5: Write new assignments against the primary identity**

In `onMouseUp` (~874-890), the `ship` binding stays `rows[shipIdx].primary` — new assignments are written against the current identity, which is what an assigner means when they drag on the row. No change needed beyond Task 2's edit; confirm `setAssignModal({ ship, dateStart, dateEnd })` and `setEditModal({ ..., ship, ... })` still pass that primary.

The `AssignModal` draft at ~1044-1056 also needs no change: `assignModal.ship` is already the primary, so `ship_id` is the current record's id and `ship_mmsi` is the shared MMSI.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 7: Verify in the browser**

Run: `npm run dev`, open `/cleanliness` (silver mode).
Expected: existing assignment dots still render on their days; the assignee filter still narrows the row list; dragging a range on a merged row opens the assign modal titled with the current ship name; clicking an already-assigned cell opens the edit modal.

- [ ] **Step 8: Commit**

```bash
git add app/coverage/CoverageGrid.tsx
git commit -m "feat(coverage): resolve assignments to MMSI rows"
```

---

### Task 7: Full verification and documentation

**Files:**
- Modify: `.claude/rules/snapshot-conventions.md` (add a row-model note)
- Test: the whole suite

- [ ] **Step 1: Run the full verification set**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected: typecheck silent exit 0; lint exit 0; vitest reports 18 passed; build completes with no type errors. Record the actual output — do not claim success without it.

- [ ] **Step 2: Document the row model where the conventions live**

Append to `.claude/rules/snapshot-conventions.md`, after the "Universe of ships" section:

```markdown
## Rows are per-MMSI, the payload is per-ship_id

The payload keeps `ships` and `voyage_cells` keyed by `ships.id`. The grid
collapses them to one row per MMSI at index time (`app/coverage/rows.ts`), so a
renamed or resold hull renders as a single row under its current name while the
tooltip can still name the ship a given day belonged to. Do not merge these
rows in the snapshot — doing so destroys the per-day attribution the hover
depends on. See `docs/superpowers/specs/2026-08-14-mmsi-row-model-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/snapshot-conventions.md
git commit -m "docs(coverage): record the per-MMSI row model"
```

- [ ] **Step 4: Report the shift in numbers**

Compare the ships KPI and overall % before and after on `/coverage`. Report both figures to Angus. Per the spec's "Known consequence", rows whose members have overlapping service windows will read lower than the two separate rows did. Name any row where the drop looks larger than the overlap explains.
