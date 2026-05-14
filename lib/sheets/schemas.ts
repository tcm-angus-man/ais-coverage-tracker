// Canonical column order for each Sheets tab.
// If you add a column here, also update the header row in the sheet and bump the /sync-sheet check.

export const ASSIGNMENTS_COLUMNS = [
  "assignment_id",
  "created_at",
  "created_by",
  "ship_mmsi",
  "ship_name",
  "cruise_line",
  "date_start",
  "date_end",
  "assignee",
  "status",
  "notes",
  "updated_at",
  "updated_by",
] as const;

export const AUDIT_LOG_COLUMNS = [
  "ts",
  "actor",
  "action",
  "assignment_id",
  "field",
  "before",
  "after",
] as const;

// Ship-level reference data: tier classification + in-service window.
// IMO-keyed because IMO is permanent; MMSI fanout happens at snapshot time.
// Dates are YYYY-MM-DD; blank service_start = active before voyage window;
// blank service_end = still in service.
export const SHIP_METADATA_COLUMNS = [
  "ship_name",
  "cruise_line",
  "imo_number",
  "ship_count",
  "cruise_type",
  "service_start",
  "service_end",
  "tier",
] as const;
