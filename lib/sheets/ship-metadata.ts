import "server-only";
import { unstable_cache } from "next/cache";
import { sheetsGet } from "./client";
import { SHIP_METADATA_COLUMNS } from "./schemas";

export type ShipMetadata = {
  imo_number: string;
  cruise_type: string;
  service_start: string | null; // YYYY-MM-DD or null
  service_end: string | null;   // YYYY-MM-DD or null
  tier: 1 | 2 | 3 | 4;
};

const SHEET_RANGE = "ship_metadata!A1:H";

function parseRow(row: string[], rowIndex: number): ShipMetadata | null {
  const imo = (row[2] ?? "").trim();
  if (!imo) return null;
  const cruise_type = (row[4] ?? "").trim();
  const service_start_raw = (row[5] ?? "").trim();
  const service_end_raw   = (row[6] ?? "").trim();
  const tier_raw          = (row[7] ?? "").trim();

  const tier = Number(tier_raw);
  if (tier !== 1 && tier !== 2 && tier !== 3 && tier !== 4) {
    throw new Error(`ship_metadata row ${rowIndex + 1}: bad tier ${JSON.stringify(tier_raw)} (imo ${imo})`);
  }

  return {
    imo_number: imo,
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
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseRow(rows[i], i);
    if (!parsed) continue;
    if (seen.has(parsed.imo_number)) continue;
    seen.add(parsed.imo_number);
    out.push(parsed);
  }
  return out;
}

export const fetchShipMetadata = unstable_cache(
  fetchShipMetadataRaw,
  ["ship_metadata"],
  { revalidate: 300, tags: ["ship_metadata"] },
);

export function indexByImo(rows: ShipMetadata[]): Map<string, ShipMetadata> {
  const m = new Map<string, ShipMetadata>();
  for (const r of rows) m.set(r.imo_number, r);
  return m;
}
