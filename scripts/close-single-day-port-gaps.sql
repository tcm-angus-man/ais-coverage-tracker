-- close-single-day-port-gaps.sql
--
-- PURPOSE
--   Close TRUE single-day processing gaps between two consecutive voyages of
--   the same ship that sit in DIFFERENT ports. When voyage A ends on day D and
--   the next voyage B (same ship, ordered by start_date) begins on day D+2,
--   day D+1 is uncovered and the heatmap renders it as a missing day. This
--   script extends A.end_date by one day (to B.start_date - 1) so the two
--   voyages meet with no hole.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   - It does NOT touch multi-day repositioning gaps (e.g. Santa Cruz
--     2023-11-25 -> San Juan 2024-02-05). Those are real gaps; GAP_DAYS is
--     pinned to exactly 1. Widen GAP_DAYS only if you truly mean "close all
--     inter-voyage holes" — that will swallow legitimate repositioning gaps.
--   - It does NOT move voyages within a same-port chain. Those rows are
--     already contiguous (end_date = next.start_date - 1), so they never match.
--     Only the LAST voyage before a different-port voyage that is 2 days out
--     is extended — which is the "extra day added to the last print of the
--     chain" behaviour.
--
-- IMPORTANT
--   - This app never writes to its read-only Postgres. RUN THIS AGAINST THE
--     SOURCE / UPSTREAM cruise-data database only, with someone who owns write
--     access. Review the dry-run SELECT output before COMMIT.
--   - Column names for the port FKs are NOT hardcoded in this repo (see
--     scripts/gap-cruises.ts, which probes information_schema). STEP 0 below
--     discovers them; substitute the confirmed names into <START_PORT_COL> /
--     <END_PORT_COL> in steps 1-3 before running.

-- ============================================================================
-- STEP 0 — discover the actual port FK column names on `voyages`.
--          Run this alone first, read the output, fill in the names below.
-- ============================================================================
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'voyages'
ORDER BY ordinal_position;
-- Expect one of: start_port_id / departure_port_id / embark_port_id / ...
--            and: end_port_id   / arrival_port_id   / disembark_port_id / ...


-- ============================================================================
-- STEP 1 — DRY RUN. Lists every voyage that WOULD be extended, with the
--          before/after end_date and the hole day being closed. Run and eyeball
--          this before doing anything destructive. Zero rows = nothing matches.
-- ============================================================================
WITH params AS (
  SELECT 1::int AS gap_days          -- exactly one uncovered day. DO NOT raise
                                      -- without re-reading the header.
),
ordered AS (
  SELECT
    v.id,
    v.ship_id,
    v.start_date,
    v.end_date,
    v.<END_PORT_COL>   AS end_port_id,
    LEAD(v.start_date)        OVER w AS next_start_date,
    LEAD(v.<START_PORT_COL>)  OVER w AS next_start_port_id,
    LEAD(v.id)                OVER w AS next_voyage_id
  FROM voyages v
  WHERE v.is_deleted = FALSE
    AND v.start_date IS NOT NULL
    AND v.end_date   IS NOT NULL
  WINDOW w AS (PARTITION BY v.ship_id ORDER BY v.start_date, v.end_date)
)
SELECT
  o.ship_id,
  o.id                              AS voyage_id,
  o.end_date                        AS end_date_before,
  o.next_start_date - 1             AS end_date_after,
  o.end_date + 1                    AS hole_day_closed,
  o.end_port_id,
  o.next_start_port_id,
  o.next_voyage_id
FROM ordered o, params p
WHERE o.next_start_date IS NOT NULL
  -- exactly `gap_days` uncovered days between this end and the next start
  AND (o.next_start_date - o.end_date) = p.gap_days + 1
  -- different ports on the two succeeding voyages (NULL-safe)
  AND o.end_port_id IS DISTINCT FROM o.next_start_port_id
ORDER BY o.ship_id, o.start_date;


-- ============================================================================
-- STEP 2 — THE UPDATE, inside an explicit transaction. Run STEP 1 first.
--          Inspect the row count returned by the UPDATE, then COMMIT or
--          ROLLBACK. Nothing is permanent until you type COMMIT.
-- ============================================================================
BEGIN;

WITH params AS (
  SELECT 1::int AS gap_days
),
ordered AS (
  SELECT
    v.id,
    v.ship_id,
    v.start_date,
    v.end_date,
    v.<END_PORT_COL>   AS end_port_id,
    LEAD(v.start_date)        OVER w AS next_start_date,
    LEAD(v.<START_PORT_COL>)  OVER w AS next_start_port_id
  FROM voyages v
  WHERE v.is_deleted = FALSE
    AND v.start_date IS NOT NULL
    AND v.end_date   IS NOT NULL
  WINDOW w AS (PARTITION BY v.ship_id ORDER BY v.start_date, v.end_date)
),
to_extend AS (
  SELECT o.id, (o.next_start_date - 1) AS new_end_date
  FROM ordered o, params p
  WHERE o.next_start_date IS NOT NULL
    AND (o.next_start_date - o.end_date) = p.gap_days + 1
    AND o.end_port_id IS DISTINCT FROM o.next_start_port_id
)
UPDATE voyages v
SET end_date = te.new_end_date
FROM to_extend te
WHERE v.id = te.id
  -- re-assert the guard at write time so a concurrent change can't widen the
  -- jump beyond a single day between SELECT and UPDATE
  AND te.new_end_date = v.end_date + 1;

-- Review the UPDATE's reported row count against STEP 1's row count.
-- They must match. If they do:
--   COMMIT;
-- otherwise:
--   ROLLBACK;
