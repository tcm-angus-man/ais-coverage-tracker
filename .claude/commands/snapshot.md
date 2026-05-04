---
description: Guided snapshot pipeline run with sanity checks
---

# /snapshot

Run the Postgres → Blob coverage snapshot pipeline with sanity checks.

## Steps

1. Read `lib/snapshot/queries.ts` and confirm the four queries match what's about to run.
2. Ask the user: **local dry-run** (writes JSON to `tmp/snapshot.json`, no Blob upload) or **production run** (writes to Vercel Blob)?
3. For local: `npm run snapshot:local` — script in `scripts/snapshot-local.ts` calls the same `lib/snapshot/build.ts` composer the cron handler uses, plus a `--dry-run` flag.
4. For production: confirm the user has `BLOB_READ_WRITE_TOKEN` and `DATABASE_URL` set, and that they really mean to run it now (the hourly cron will run it automatically).
5. Validate the output JSON shape against `lib/snapshot/types.ts` (the `CoveragePayload` type).
6. Surface anomalies and require confirmation before proceeding:
   - Snapshot >20% smaller than the previous one
   - Ships in `team_config` missing from `snapshot.ships`
   - Date gaps in `snapshot.dates`
   - Total JSON > 10MB before brotli (raw — usually means a query went wrong)
7. Report a one-line summary: ships count × dates count × total cells, generated_at, output bytes.

## Hard rules

- Never paste actual snapshot rows into chat.
- Never read files in `tmp/`, `scratch/`, or files matching `*.snapshot.json` — these are blocked in `.claude/settings.json`.
- Operate on shapes, counts, and field names — not values.
