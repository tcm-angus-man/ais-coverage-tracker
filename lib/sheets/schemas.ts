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
