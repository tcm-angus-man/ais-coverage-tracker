export type Ship = {
  id: number;
  mmsi: number;
  name: string;
  display_name: string;
  cruise_line: string;
  imo_number: string;
  in_service: boolean;
};

export type Cell = {
  t: number;
  v: number;
  na: number;
  dw: number;
  np: number;
  dt: number;
  dd: number;
  sp: number;
  ol: number;
  /** Silver only: 1 if the underlying silver_state row was last updated by a human (not data-platform), else 0. */
  u?: number;
  /** Silver only: the db updated_by value (numeric string) when u=1, undefined otherwise. */
  updated_by?: string;
};

export type CoveragePayload = {
  generated_at: string;
  date_range: { start: string; end: string };
  ships: Ship[];
  dates: string[];
  voyage_cells: Record<string, Record<string, Cell>>;
  silver_cells: Record<string, Record<string, Cell>>;
};
