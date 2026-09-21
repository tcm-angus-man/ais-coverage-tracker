# Sizing the coverage payload for the full ais_silver backfill

## The problem

Widening the cleanliness window to 2015 grows `ais_silver_summary` from 278,614
rows to 1,566,029 today, and to roughly 2.8M once ingestion finishes (+80%),
then ~620 new ship-days/day forever. Does the single-JSON-blob architecture
survive that?

## The approach

Measured instead of estimating, without touching production data — per
`.claude/rules/data-privacy.md`, built a synthetic payload of the same *shape*
and volume and ran it through the real `lib/snapshot/compress.ts`.

1. Found the hard wall first:
   `node -p "require('buffer').constants.MAX_STRING_LENGTH"` -> 536,870,888
   chars (~512 MB). `compressJson` does `JSON.stringify(payload)` on the whole
   object, so this is a crash ceiling, not a slowdown.
2. Wrote a benchmark generating `voyage_cells` / `silver_cells` records with
   realistic value distributions (AIS pings in the hundreds-to-thousands,
   anomaly counts mostly zero). Value realism matters: brotli's ratio depends
   on it, and uniform synthetic values would flatter the result.
3. Ran three volumes (silver cells, with voyage_cells held at 2.0M, 700 ships,
   4,282 dates):

   | scenario                | JSON      | % of 512MB | brotli q6 | peak RSS |
   |-------------------------|-----------|-----------|-----------|----------|
   | today (narrow, 278,614) | 168.6 MB  | 32.9%     | 5.2 MB    | 1.52 GB  |
   | widened now (1,566,029) | 277.1 MB  | 54.1%     | 8.3 MB    | 1.94 GB  |
   | ingestion done (2.82M)  | 382.6 MB  | 74.7%     | 11.2 MB   | 2.17 GB  |

4. Separately simulated `app/api/coverage/route.ts`, which decompresses the
   blob, parses it, then `NextResponse.json()` re-stringifies the whole thing:
   1.7s + 1.5s CPU, 379 MB response body, **2.2 GB peak per request**.

Derived costs: 88.3 bytes per silver cell, ~76 per voyage cell, ~620 new silver
ship-days/day => ~93 KB/day of JSON growth once the backfill is done. Remaining
headroom after completion is ~136 MB, so roughly **4 years** before
`JSON.stringify` throws `Invalid string length`.

## The judgment calls

- **Did not change the payload encoding.** The brief was to verify, not to fix.
  Compressed size (11 MB) was never the problem; the uncompressed intermediate
  string and per-request memory are.
- **Did not treat the cron as the binding constraint.** It runs hourly and
  peaks at 2.2 GB. `/api/coverage` peaks at the same 2.2 GB on *every page
  load*, because the route sets `Cache-Control: no-store` — that is the
  pressing limit, and it contradicts `.claude/rules/snapshot-conventions.md`,
  which documents `max-age=3600`.
- **Held voyage_cells at a flat 2.0M** rather than guessing its true value,
  since the silver axis is what is changing and per-cell costs make the model
  re-computable for any voyage figure.

## The reusable rule

When asked whether a data volume is "fine", never answer from arithmetic on
cell counts — generate a synthetic payload of the same shape at the target
volume and run it through the real serialisation code, because the binding
limit is usually an intermediate representation (a 512 MB max JS string, a
per-request re-serialisation) that never appears in the row count or the
compressed artifact you were reasoning about.
