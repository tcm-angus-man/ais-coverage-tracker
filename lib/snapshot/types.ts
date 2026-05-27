// Internal snapshot row types for the four queries.
// The wire format (CoveragePayload, Ship, Cell) lives in app/coverage/types.ts
// and is what we serialise to the Blob.

export type ShipRow = {
  id: number;
  mmsi: number;
  name: string;
  display_name: string;
  cruise_line: string;
  imo_number: string;
  in_service: boolean;
  // Joined from Google Sheets ship_metadata tab. Tier defaults to 4 when no
  // metadata row matches the imo_number. service_start/end are null when
  // the ship has been active since before the voyage window / is still in service.
  cruise_type: string | null;
  service_start: string | null;
  service_end: string | null;
  tier: 1 | 2 | 3 | 4;
};

// Voyage cells are keyed by ship_id — voyages are processed per ship, so
// ships sharing an MMSI each get their own coverage.
export type VoyageCellRow = {
  ship_id: number;
  date: string; // YYYY-MM-DD
  t: number;
  v: number;
  na: number;
  dw: number;
  np: number;
};

// Silver rows come from ais_silver_summary which is keyed by MMSI in Postgres
// (AIS pings are per-hull, not per-ship-record). The builder fans these out
// to each ship_id sharing the MMSI, attributing by service window.
export type SilverCellRow = {
  mmsi: number;
  date: string;
  t: number;
  v: number;
  na: number;
  dw: number;
  np: number;
  dt: number;
  dd: number;
  sp: number;
  ol: number;
  u: number; // 1 if last touched by a human (not data-platform), else 0
  updated_by: string | null; // raw db updated_by value when u=1, null otherwise
};

// Two anchored windows — see .claude/rules/snapshot-conventions.md
export const VOYAGE_START = "2015-01-01";
export const SILVER_START = "2025-07-01";
