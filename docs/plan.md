# ais-coverage-tracker — plan

This is the working version of the brief. Update as decisions land.

## Status: Phase 0 complete

- Repo scaffolded
- `.claude/` populated
- NextAuth + Google + domain gate stubbed (team_config is a hard-coded map; switches to Sheets in Phase 2)
- Kept files (`CoverageGrid`, `CoverageLoader`, `types`) live at `app/coverage/`, untouched
- `/api/coverage` returns an inline 4-ship × 60-day fixture so the heatmap renders
- Real snapshot pipeline arrives in Phase 1

## Push-back questions still open (gate Phase 1)

1. **`Cell` fields.** `t = total prints`, `v = visible_on_globe count` confirmed in component. Canonical names for `na`, `dw`, `np`?
2. **Universe of ships.** Filter rule for `snapshot.ships`?
3. **Date window.** Default `SNAPSHOT_DAYS_BACK=730` — confirm.
4. **`imo_siblings`.** Reserved on the type. Used for sister-ship grouping later?
5. **Status `done`.** Terminal until reopened by an assigner — confirm.
6. **Notes.** Single append-only column with `[author @ ISO]\n` prefix — confirm.
7. **Notifications.** None in v1 — confirm.

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
