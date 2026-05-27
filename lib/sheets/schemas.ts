// Canonical column order for each Sheets tab.
// If you add a column here, also update the header row in the sheet and bump the /sync-sheet check.

// ship_id is appended at the end so existing rows keep their positional
// alignment. Legacy rows (no ship_id) get resolved at read-time by looking
// up the first ship matching ship_mmsi.
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
  "ship_id",
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
// imo_number is the durable vessel identity (survives MMSI changes/reflags)
// and is the primary key for the voyage tab's service-window lookup; mmsi is
// retained for the cleanliness tab and as a fallback when imo_number is blank.
// imo_number is appended at the end (column H) so existing row positions are
// preserved. Dates are YYYY-MM-DD; blank service_start = active before voyage
// window; blank service_end = still in service.
export const SHIP_METADATA_COLUMNS = [
  "ship_name",
  "cruise_line",
  "mmsi",
  "cruise_type",
  "service_start",
  "service_end",
  "tier",
  "imo_number",
] as const;
