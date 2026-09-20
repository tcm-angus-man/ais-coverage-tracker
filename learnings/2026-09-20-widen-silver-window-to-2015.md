# Widening the cleanliness (silver) window from 2025-07-01 to 2015-01-01

## The problem

The `/cleanliness` tab only rendered AIS-silver ship-days from `2025-07-01`, but
`ais_silver_summary` is being backfilled fleet-wide to 2015, so the tab needed
to show the full history.

## The approach

1. Found every site holding the window, not just the obvious one:
   `grep -rn "2025-07-01" --include="*.ts" --include="*.tsx" --include="*.md" .`
   It lived in **four** places — `lib/snapshot/types.ts` (`SILVER_START`, feeds
   the SQL `$1`), a re-declared literal inside `app/coverage/CoverageGrid.tsx`
   (`indexPayload`), a user-facing subtitle in `app/coverage/CoverageShell.tsx`,
   and two docs (`.claude/rules/snapshot-conventions.md`, `docs/plan.md`).
2. Traced what the constant actually drives before changing it:
   `fetchSilverCells` in `lib/snapshot/queries.ts` parameterises it as `$1`, so
   the SQL follows automatically; the client constant only drives
   `silverDateOffset` / `silverDates`, which now collapse to `0` / the full
   `dates` axis.
3. Removed the duplicated client literal and imported `SILVER_START` from
   `@/lib/snapshot/types` instead. That module is a leaf (no imports), so a
   `"use client"` component can import it without dragging `pg` into the bundle.
4. Verified in this order: `npm run typecheck`, `npm run test` (31 passing),
   `npm run lint`, `npm run build`.
5. The build reported prerender errors on `/404` and `/500`. Rather than assume
   they were pre-existing, ran the disconfirming check: `git stash` → build →
   same two errors → `git stash pop`. Confirmed unrelated to the change.
6. Confirmed the bundle claim empirically rather than by reasoning:
   `grep -rl "pg-connection-string\|DATABASE_URL\|statement_timeout" .next/static/chunks`
   returned nothing, and `grep -rho "2015-01-01\|2025-07-01" .next/static/chunks`
   showed only the new value.

## The judgment calls

- **Did not touch the SQL in `fetchSilverCells`.** The window is already a bound
  parameter, so it widens for free. Pre-optimising the query (e.g. replacing the
  correlated `EXISTS` against `ships` with a CTE semi-join) would have been
  speculation without an `EXPLAIN`, and `.claude/rules/data-privacy.md` forbids
  the model from touching the production database to get one. Flagged the
  `statement_timeout: 60_000` in `lib/snapshot/db.ts` as the thing to watch.
- **Did not compact the payload encoding.** The window is ~9.6x wider (447 days
  → 4,281 days). At full backfill that is roughly 510 ships x 4,281 days ≈ 2.2M
  silver cells, ~190MB of JSON on top of the existing voyage cells.
  `lib/snapshot/compress.ts` calls `JSON.stringify` on the whole payload, and
  V8 caps a single string at ~536MB — a real ceiling, but not one that's hit
  today while the backfill is partial. Flagged rather than pre-solved.
- **Did not adjust the silver KPI denominator.** `CoverageGrid.tsx` computes
  "% cleaned" over `ships x silverDates`, which now includes a decade of
  pre-backfill days, so the headline number drops sharply. That is the honest
  number for the new window; changing it would be a product decision.

## The reusable rule

Before changing a constant, grep the whole repo for its literal value — a value
that appears in both a server module and a client component is two constants
that have already drifted or are about to; collapse them to one import, and
prove the import is bundle-safe by grepping the built chunks rather than
reasoning about it.
