# One row per MMSI in the coverage + cleanliness heatmap

Date: 2026-08-14
Status: approved, not yet implemented

## Problem

The heatmap renders one row per Postgres `ships.id`. A hull that was renamed
or resold keeps its AIS MMSI but gains a second `ships` row, so the same
physical vessel appears as two rows — one mostly-empty historical row and one
current row. Operators read the grid per hull, not per database record, so the
split is noise.

We want one row per MMSI, labelled with the vessel's current name, without
losing the ability to say which named ship a given day belonged to.

## Decisions taken (2026-08-14, Angus)

1. **Primary ship** — the member with `in_service = true` wins; ties break on
   the most recent day with a voyage cell where `t > 0`, then name A→Z. Voyage
   cells are the tie-breaker rather than silver because silver is fanned out
   identically to every member and so cannot separate them.
2. **Cleanliness hover** — lists every name sharing the MMSI. Silver data is
   MMSI-keyed and identical across members, so there is no per-day owner to
   resolve.
3. **Coverage %** — union of members. A day is in the denominator if it falls
   inside any member's service window; it is covered if any member has
   `v >= 1`.

## Approach

Collapse rows **client-side in `indexPayload`**. The snapshot payload stays
ship_id-keyed.

Merging in `lib/snapshot/build.ts` was rejected: once cells are summed
server-side, the per-day attribution that drives the hover is gone. Keeping
`voyage_cells` keyed by ship_id is precisely what makes "which ship was this on
this day" answerable. It also means no payload version bump and no cron re-run.

Blast radius is `app/coverage/CoverageGrid.tsx` plus one new pure module.
`app/api/admin/ship-metadata-debug`, `app/api/admin/ship-metadata-rekey` and
`app/api/coverage` consume the payload shape, which does not change.

## Row model

`indexPayload` returns `rows: Row[]` in place of `ships: Ship[]`:

```ts
type Row = {
  key: string;        // `m:${mmsi}`, or `s:${id}` when mmsi is 0/missing
  mmsi: number;
  primary: Ship;      // in_service → latest day with data → name A→Z
  members: Ship[];    // primary first, then the rest
};
```

Row index continues to drive filters, sorts, canvas draw, hit-test and KPIs.
Those read `row.primary` / `row.members` instead of `ships[i]`.

Ships with no MMSI (`mmsi` null or 0) each get their own row keyed `s:${id}`,
so they are never merged with each other.

## Cell merging

Per row, per day:

- **Voyage** — `t`, `v`, `na`, `dw` are summed across members. Members own
  disjoint voyages (`voyages.ship_id`), so a day on which two members each have
  a voyage genuinely carries two voyages for that hull.
- **Voyage `np`** — `1` only when the merged `t === 0` and at least one member
  flagged that day as a gap. A day covered by any member is not a gap.
- **Silver** — members carry identical fanned-out data (see
  `lib/snapshot/build.ts`, which writes each MMSI row to every ship_id sharing
  it). Summing would double-count, so take the member cell with the highest
  `t`. This matches what the existing `silverGroups` KPI merge already does.
- **Silver `u` / `updated_by`** — carried from the cell that wins on `t`.

## Service window and out-of-service

`isOutOfService` becomes row-level: a day is out of service only when it falls
outside **every** member's `[service_start, service_end]` window. This is the
union rule from decision 3, and it governs both the hatched out-of-service cell
rendering and the coverage denominator.

The left-column name is greyed (`C_INK_FAINT`) only when no member is in
service.

## Hover

`TooltipState` carries the `Row` and the hovered date.

- Header: `primary.display_name`, unchanged in style.
- New attribution line below it:
  - **Voyage / combined** — the members whose voyage cell has `t > 0` on that
    date, comma-joined. Two ships with data that day shows both names. Resolved
    at hover time with an O(members) lookup into `payload.voyage_cells`,
    identical in cost to the single-ship lookup it replaces, so no extra memory
    is retained.
  - **Cleanliness** — every member name on that MMSI (decision 2).
  - Suppressed entirely on single-member rows, where it would only repeat the
    header.
- IMO line: the primary's IMO, plus any member IMO that differs.

## KPIs and per-row coverage

- Voyage: iterate rows; merged cells and union out-of-service. The COVID
  adjustment (≥10-day visible run anchored within 7 days of a boundary) runs
  against the **merged** voyage cells, so a run that spans a rename is no longer
  broken in two.
- Silver: `silverGroups` is deleted. Rows are the MMSI groups, so the KPI loops
  rows directly against merged silver cells.
- The `ships` KPI now counts distinct MMSI rows and will read lower than today.

## Assignments

- `assignedCells` lookup checks every member's ship_id, so an assignment written
  against the superseded hull still surfaces on the merged row.
- New assignments write `primary.id` and the shared MMSI.
- `filteredAssigneeShipIds` matches when any member matches.

## Filters and sorting

Filters match when **any** member matches, so a row never disappears because the
primary alone failed the predicate:

- Text search — any member's `display_name`, `name`, `cruise_line`, or MMSI.
- Tier, cruise line, assignee, silver-presence — any member.

Sorting uses `primary` for `name`, `imo`, and `cruise_line`; `coverage_pct`,
`coverage_days` and `activity` use the merged row values.

## Testing

Per `.claude/rules/testing.md` the canvas itself gets no test. The merge logic
is real behaviour, so it moves into a pure module `app/coverage/rows.ts`
(`buildRows`, `mergeVoyageCell`, `mergeSilverCell`, `rowIsOutOfService`,
`voyageOwnersForDate`) covered by vitest against synthetic fixtures:

- Two ships sharing an MMSI with disjoint service windows collapse to one row
  and the union denominator equals the sum of the two former denominators.
- An overlap day where both members have voyages counts once in the denominator
  and sums `t`.
- Silver cells identical across members merge to one cell, not a doubled `t`.
- A ship with `mmsi = 0` keeps its own row.
- Primary selection: `in_service` beats a member with more recent data.
- `np` clears when any member covers the day.

Fixtures are synthetic and live with the test, per
`.claude/rules/data-privacy.md`.

## Known consequence

This reverses the 2026-05-27 "keep the identity keys separate" decision for the
row dimension only. Voyage coverage moves from per-ship_id to per-hull. Where
two ships sharing an MMSI have disjoint service windows the numbers are
effectively unchanged. Where their windows **overlap**, the merged row reads
lower than the two separate rows did, because the overlapping days now count
once instead of twice. That is the more defensible number, but it is a visible
shift and worth watching after deploy.
