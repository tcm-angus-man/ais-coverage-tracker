import type { CoveragePayload, Cell } from "@/app/coverage/types";
import { getPool, endPool } from "./db";
import {
  fetchShips,
  fetchVoyageCells,
  fetchSilverCells,
  buildDateAxis,
} from "./queries";
import { VOYAGE_START } from "./types";
import { compressJson } from "./compress";
import { putCoverageBlob, type BlobPutResult } from "./blob";

export type BuildResult = {
  generated_at: string;
  ships: number;
  voyage_cell_rows: number;
  silver_cell_rows: number;
  bytes_compressed: number;
  blob: BlobPutResult;
};

export async function buildSnapshot(): Promise<BuildResult> {
  const pool = getPool();

  const [ships, voyageRows, silverRows] = await Promise.all([
    fetchShips(pool),
    fetchVoyageCells(pool),
    fetchSilverCells(pool),
  ]);
  const dates = buildDateAxis();

  const voyage_cells: Record<string, Record<string, Cell>> = {};
  for (const r of voyageRows) {
    const m = String(r.mmsi);
    (voyage_cells[m] ??= {})[r.date] = {
      t: r.t,
      v: r.v,
      na: r.na,
      dw: r.dw,
      np: r.np,
      dt: 0,
      dd: 0,
      sp: 0,
      ol: 0,
    };
  }

  const silver_cells: Record<string, Record<string, Cell>> = {};
  for (const r of silverRows) {
    const m = String(r.mmsi);
    (silver_cells[m] ??= {})[r.date] = {
      t: r.t,
      v: r.v,
      na: r.na,
      dw: r.dw,
      np: r.np,
      dt: r.dt,
      dd: r.dd,
      sp: r.sp,
      ol: r.ol,
      u: r.u,
      ...(r.updated_by != null ? { updated_by: r.updated_by } : {}),
    };
  }

  const generated_at = new Date().toISOString();
  const payload: CoveragePayload = {
    generated_at,
    date_range: { start: VOYAGE_START, end: dates[dates.length - 1] },
    ships: ships.map((s) => ({
      id: s.id,
      mmsi: s.mmsi,
      name: s.name,
      display_name: s.display_name,
      cruise_line: s.cruise_line,
      imo_number: s.imo_number,
      in_service: s.in_service,
    })),
    dates,
    voyage_cells,
    silver_cells,
  };

  const compressed = await compressJson(payload);
  const blob = await putCoverageBlob(compressed);

  return {
    generated_at,
    ships: ships.length,
    voyage_cell_rows: voyageRows.length,
    silver_cell_rows: silverRows.length,
    bytes_compressed: compressed.length,
    blob,
  };
}

export { endPool };
