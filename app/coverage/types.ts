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
};

export type CoveragePayload = {
  generated_at: string;
  date_range: { start: string; end: string };
  ships: Ship[];
  dates: string[];
  voyage_cells: Record<string, Record<string, Cell>>;
  silver_cells: Record<string, Record<string, Cell>>;
};
