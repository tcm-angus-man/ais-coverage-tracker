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
};

export type VoyageCellRow = {
  mmsi: number;
  date: string; // YYYY-MM-DD
  t: number;
  v: number;
  na: number;
  dw: number;
  np: number;
};

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
