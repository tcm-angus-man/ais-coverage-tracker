# ais-coverage-tracker — plan

This is the working version of the brief. Update as decisions land.

## Status: Phase 0 complete

- Repo scaffolded
- `.claude/` populated
- NextAuth + Google + domain gate stubbed (team_config is a hard-coded map; switches to Sheets in Phase 2)
- Kept files (`CoverageGrid`, `CoverageLoader`, `types`) live at `app/coverage/`, untouched
- `/api/coverage` returns an inline 4-ship × 60-day fixture so the heatmap renders
- Real snapshot pipeline arrives in Phase 1

## Decisions (resolved 2026-05-05, gates lifted for Phase 1)

1. **`Cell` fields.** Refined from initial spec — see `.claude/rules/snapshot-conventions.md` for canonical definitions. Highlights:
   - **`t`** is voyage *count* (not print count) on the voyage side; `row_count` on the silver side.
   - **`v`** is the "reviewed/clean" subset of `t`: voyages with `visible_on_globe=TRUE` on voyage; silver days with all four anomaly counts zero on silver.
   - **`np`** flags gap days: a day inside a ship's active voyage range with *no* voyage covering it (e.g. ship has voyages 2015-01-01 to -10 and -12 to -20 → 2015-01-11 is `np=1`).
2. **Universe of ships.**
   - **Voyage:** every non-river-cruise ship with an `mmsi` that has ever been requested (a voyage linked to `prints.id`). Not date-windowed.
   - **Silver:** ships present in `silver_cells` over the silver window.
   The `ships` array is the union.
3. **Date window.** Two anchored windows — voyage from `2015-01-01`, silver from `2025-07-01`, both ending today. `SNAPSHOT_DAYS_BACK` is dropped.
4. **`imo_siblings`.** Dropped from the `Ship` type.
5. **Status `done` = reviewed.** A ship-day is `done` iff all four `silver_state` anomaly counts are zero: `delta_time_count`, `delta_distance_count`, `spike_count`, `overland_count`. Terminal in the assignment lifecycle.
6. **Notes.** Single append-only `notes` column on the assignment row, each entry prefixed `[author @ ISO]\n`.
7. **Notifications.** None in v1.

## Phase 1 follow-ups surfaced by the above

- ~~Silver QA counts on `Cell`.~~ **Resolved 2026-05-05.** Added as `dt`, `dd`, `sp`, `ol` on the `Cell` type — required ints, zero on voyage cells, real values on silver cells.

## Phase ordering

Phase 0 — scaffold + auth + fixture **(done)**
Phase 1 — Postgres → Blob snapshot pipeline (hourly cron, brotli, ETag)
Phase 2 — Sheets reads, `/queue` populated, role lookup from real `team_config`
Phase 3 — selection panel rebuild, `/api/sheets/assignments` POST + audit log
Phase 4 — assignment overlay on the heatmap (`renderOverlay` prop on CoverageGrid)
Phase 5 — `/me` + status update flow
Phase 6 — `/team` leaderboard + velocity chart
Phase 7 — drag-select for bulk assignment + filters + polish

Ship 0–3 first, use it for two weeks before building the overlay.

## Architecture sketch

```
Postgres (RO) ──hourly──▶ /api/cron/snapshot ──▶ coverage-latest.json (Vercel Blob)
                                                         │
                                                         ▼
                                              Next.js app (Vercel)
                                                  ▲       │
                                                  │       ▼
                                          NextAuth+Google  /api/sheets/*
                                                          │
                                                          ▼
                                                Google Sheets workbook
                                                  (assignments,
                                                   team_config,
                                                   audit_log)
```

## Visual language

See `docs/design-system.md`. Match the existing CoverageGrid: neutral-950 ground, emerald-700 accents, dense controls, tabular-nums on numbers, no decorative flourishes.
