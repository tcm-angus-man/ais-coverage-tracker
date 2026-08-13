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
