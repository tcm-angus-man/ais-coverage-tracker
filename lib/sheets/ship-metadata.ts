import "server-only";
import { unstable_cache } from "next/cache";
import { sheetsGet } from "./client";
import { SHIP_METADATA_COLUMNS } from "./schemas";

export type ShipMetadata = {
  mmsi: number;
  cruise_type: string;
  service_start: string | null; // YYYY-MM-DD or null
  service_end: string | null;   // YYYY-MM-DD or null
  tier: 1 | 2 | 3 | 4;
};

const SHEET_RANGE = "ship_metadata!A1:G";

function parseRow(row: string[], rowIndex: number): ShipMetadata | null {
  const mmsiRaw = (row[2] ?? "").trim();
  if (!mmsiRaw) return null;
  const mmsi = Number(mmsiRaw);
  if (!Number.isInteger(mmsi) || mmsi <= 0) {
    throw new Error(`ship_metadata row ${rowIndex + 1}: bad mmsi ${JSON.stringify(mmsiRaw)}`);
  }
  const cruise_type = (row[3] ?? "").trim();
  const service_start_raw = (row[4] ?? "").trim();
  const service_end_raw   = (row[5] ?? "").trim();
  const tier_raw          = (row[6] ?? "").trim();

  const tier = Number(tier_raw);
  if (tier !== 1 && tier !== 2 && tier !== 3 && tier !== 4) {
    throw new Error(`ship_metadata row ${rowIndex + 1}: bad tier ${JSON.stringify(tier_raw)} (mmsi ${mmsi})`);
  }

  return {
    mmsi,
    cruise_type,
    service_start: service_start_raw || null,
    service_end: service_end_raw || null,
    tier: tier as 1 | 2 | 3 | 4,
  };
}

async function fetchShipMetadataRaw(): Promise<ShipMetadata[]> {
  const rows = await sheetsGet(SHEET_RANGE);
  if (rows.length === 0) return [];

  const header = rows[0];
  for (let i = 0; i < SHIP_METADATA_COLUMNS.length; i++) {
    if ((header[i] ?? "").trim() !== SHIP_METADATA_COLUMNS[i]) {
      throw new Error(`ship_metadata header mismatch col ${i}: got ${JSON.stringify(header[i])}, want ${SHIP_METADATA_COLUMNS[i]}`);
    }
  }

  const out: ShipMetadata[] = [];
  const seen = new Set<number>();
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseRow(rows[i], i);
    if (!parsed) continue;
    if (seen.has(parsed.mmsi)) continue;
    seen.add(parsed.mmsi);
    out.push(parsed);
  }
  return out;
}

export const fetchShipMetadata = unstable_cache(
  fetchShipMetadataRaw,
  ["ship_metadata"],
  { revalidate: 300, tags: ["ship_metadata"] },
);

// Bypasses the cache. Use from debug endpoints and the snapshot cron where
// we want the current sheet state without a 5-minute lag.
export const fetchShipMetadataUncached = fetchShipMetadataRaw;

export function indexByMmsi(rows: ShipMetadata[]): Map<number, ShipMetadata> {
  const m = new Map<number, ShipMetadata>();
  for (const r of rows) m.set(r.mmsi, r);
  return m;
}
