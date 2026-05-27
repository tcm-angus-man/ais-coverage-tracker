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
import { fetchShipMetadataUncached, indexByVessel, indexByMmsi, indexByImo, vesselKey, type ShipMetadata } from "@/lib/sheets/ship-metadata";

export type BuildResult = {
  generated_at: string;
  ships: number;
  voyage_cell_rows: number;
  silver_cell_rows: number;
  bytes_compressed: number;
  blob: BlobPutResult;
};

// Sheets metadata fetch is best-effort: if it fails (network, malformed sheet)
// we fall back to "everything is Tier 4 with no service window" so the cron
// still produces a snapshot. The team has rules/sheets-integration.md saying
// audit appends are best-effort; same principle here.
async function fetchShipMetadataSafe(): Promise<ShipMetadata[]> {
  try {
    return await fetchShipMetadataUncached();
  } catch (err) {
    console.error("[snapshot] ship_metadata fetch failed, defaulting all ships to Tier 4:", err);
    return [];
  }
}

export async function buildSnapshot(): Promise<BuildResult> {
  const pool = getPool();

  const [ships, voyageRows, silverRows, metadata] = await Promise.all([
    fetchShips(pool),
    fetchVoyageCells(pool),
    fetchSilverCells(pool),
    fetchShipMetadataSafe(),
  ]);
  const dates = buildDateAxis();
  const metadataByVessel = indexByVessel(metadata);
  const metadataByMmsi = indexByMmsi(metadata);
  const metadataByImo = indexByImo(metadata);

  // Service window + tier come from the ship_metadata sheet. Resolve each ship
  // to its sheet row by (mmsi, display_name) first — this disambiguates two
  // hulls sharing an MMSI (e.g. VILLA VIE ODYSSEY vs BRAEMAR), which an
  // MMSI-only lookup conflated, handing one vessel the other's window. Fall
  // back to imo_number, then bare mmsi, for rows where the name didn't match.
  const metaForShip = (s: (typeof ships)[number]): ShipMetadata | undefined =>
    metadataByVessel.get(vesselKey(s.mmsi, s.display_name)) ??
    (s.imo_number ? metadataByImo.get(s.imo_number) : undefined) ??
    metadataByMmsi.get(s.mmsi);

  // Voyage cells are keyed by ship_id (voyages processed per ship).
  const voyage_cells: Record<string, Record<string, Cell>> = {};
  for (const r of voyageRows) {
    (voyage_cells[String(r.ship_id)] ??= {})[r.date] = {
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

  // Silver cells stay keyed by MMSI — cleanliness is processed per MMSI, so
  // ships sharing an MMSI legitimately share silver data. We fan each MMSI
  // row out to every ship_id sharing it so the renderer (which indexes cells
  // by ship_id) finds them.
  const shipsByMmsi = new Map<number, typeof ships>();
  for (const s of ships) {
    const arr = shipsByMmsi.get(s.mmsi) ?? [];
    arr.push(s);
    shipsByMmsi.set(s.mmsi, arr);
  }

  const silver_cells: Record<string, Record<string, Cell>> = {};
  for (const r of silverRows) {
    const shipsForMmsi = shipsByMmsi.get(r.mmsi);
    if (!shipsForMmsi || shipsForMmsi.length === 0) continue;
    const cell: Cell = {
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
    for (const s of shipsForMmsi) {
      (silver_cells[String(s.id)] ??= {})[r.date] = cell;
    }
  }

  const generated_at = new Date().toISOString();
  const payload: CoveragePayload = {
    generated_at,
    date_range: { start: VOYAGE_START, end: dates[dates.length - 1] },
    ships: ships.map((s) => {
      const meta = metaForShip(s);
      return {
        id: s.id,
        mmsi: s.mmsi,
        name: s.name,
        display_name: s.display_name,
        cruise_line: s.cruise_line,
        imo_number: s.imo_number,
        in_service: s.in_service,
        cruise_type: meta?.cruise_type ?? null,
        service_start: meta?.service_start ?? null,
        service_end: meta?.service_end ?? null,
        tier: meta?.tier ?? 4,
      };
    }),
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
