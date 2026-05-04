# Snapshot conventions

The hourly cron at `/api/cron/snapshot` regenerates a single `coverage-latest.json` on Vercel Blob. Page renders never run live SQL.

## `Cell` field meanings

Confirmed from `app/coverage/CoverageGrid.tsx`:

- `t` — total prints (clamped 0..255 for the rendering Uint8Array; the JSON itself stores the full int)
- `v` — visible_on_globe count (clamped 0..255 likewise)

Pending confirmation from the user (gates Phase 1):

- `na` — likely "no AIS"
- `dw` — likely "details wrong"
- `np` — likely "no print"

These are surfaced in the right-side panel only — they don't affect cell colour.

## Universe of ships

Default: ships present in either `voyage_cells` or `silver_cells` over the date window. `in_service=false` ships are included but greyed in the row header (CoverageGrid renders them at 50% opacity). Phase 7 adds a filter to hide them.

## Date window

`SNAPSHOT_DAYS_BACK` env var, default `730` (24 months). Computed at cron time. Static at render.

## Output shape

```ts
type CoveragePayload = {
  generated_at: string;          // ISO datetime
  date_range: { start: string; end: string };
  ships: Ship[];                  // see app/coverage/types.ts
  dates: string[];                // YYYY-MM-DD, ascending
  voyage_cells: Record<string, Record<string, Cell>>; // mmsi → date → Cell
  silver_cells: Record<string, Record<string, Cell>>;
};
```

## Storage

- Brotli-compressed `coverage-latest.json` on Vercel Blob.
- ETag is the `generated_at` ISO string.
- `Cache-Control: max-age=3600` on `/api/coverage` (matches cron cadence).
- One file. Not versioned. Cron overwrites.

## Indexing notes

The four queries are: ships, voyage_cells, silver_cells, dates. Each is one round-trip. If you find yourself joining ships into voyage_cells in SQL, stop — the client-side `indexPayload` in `CoverageGrid.tsx` does that join in JS via `Map<mmsi, Uint8Array>`. Keep the queries flat.

## Failure mode

If the cron fails one hour, the previous snapshot is still served. Degraded, not broken. Don't add fallback synthesis logic — let it return stale data.
