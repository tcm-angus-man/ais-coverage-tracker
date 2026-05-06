# Snapshot conventions

The hourly cron at `/api/cron/snapshot` regenerates a single `coverage-latest.json` on Vercel Blob. Page renders never run live SQL.

## `Cell` field meanings

- `t` — density count (clamped 0..255 for the rendering Uint8Array; the JSON itself stores the full int)
  - **voyage cells**: number of `voyages` covering this ship-day
  - **silver cells**: `ais_silver_summary.row_count` (number of AIS pings)
- `v` — "clean / reviewed" count, parallel to `t` (clamped 0..255 likewise)
  - **voyage cells**: subset of `t` where `voyages.visible_on_globe = TRUE`
  - **silver cells**: equals `t` if all four anomaly counts are zero, else `0`
- `na` — voyage cells: count where `route_file_location IS NULL` OR `globe_customer_notification = 'No data available'`. Silver cells: `0`.
- `dw` — voyage cells: count where `globe_customer_notification = 'Details are wrong'`. Silver cells: `0`.
- `np` — voyage cells: `1` for gap days (a day inside the ship's active voyage range with no voyage covering it), `0` otherwise. Silver cells: `0`.
- `dt` — `ais_silver_summary.delta_time_count` (silver-only)
- `dd` — `ais_silver_summary.delta_distance_count` (silver-only)
- `sp` — `ais_silver_summary.spike_count` (silver-only)
- `ol` — `ais_silver_summary.overland_count` (silver-only)

`na`, `dw`, `np`, and the four silver QA counts are surfaced in the right-side panel only — they don't affect cell colour today. (`np > 0` cells have `t = 0` and currently render transparent — UI follow-up may colour them differently.)

## Universe of ships

The `ships` array is the union of the voyage and silver universes:

- **Voyage universe** — every non-river-cruise ship with an `mmsi` that has ever been requested (i.e. has a voyage linked to `prints.id`). Not date-windowed: a ship qualifies even if its only request is outside the snapshot window.
- **Silver universe** — ships present in `silver_cells` over the silver date window.

`in_service=false` ships are included but greyed in the row header (CoverageGrid renders them at 50% opacity). Phase 7 adds a filter to hide them.

## Date window

Two anchored windows, not a rolling `DAYS_BACK`:

- **Voyage cells**: `2015-01-01` → today
- **Silver cells**: `2025-07-01` → today

The payload's `dates` array spans the voyage window (the wider of the two). `silver_cells` is naturally empty for dates before `2025-07-01`. End-dates are computed at cron time.

## Silver "clean" criterion

A ship-day in `silver_cells` is considered **reviewed / clean** when all four anomaly counts on `silver_state` are zero: `delta_time_count`, `delta_distance_count`, `spike_count`, `overland_count`. This is what an assignment's `done` status corresponds to. The counts are exposed on the `Cell` type as `dt`, `dd`, `sp`, `ol` so the UI can verify "clean" without a second query.

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
