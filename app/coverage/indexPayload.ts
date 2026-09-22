import type { Cell, CoveragePayload } from "./types";
import type { Row } from "./rows";
import { buildRows, mergeSilverCells, mergeVoyageCells } from "./rows";
import { SILVER_START } from "@/lib/snapshot/types";

// Moved out of CoverageGrid so /gaps can share the exact same row model and
// merged layers without pulling the canvas component into its bundle. The
// logic is unchanged.

export type LayerMeta = { cells: (Cell | null)[][] };

export type Indexed = {
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

export function indexPayload(payload: CoveragePayload): Indexed {
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
