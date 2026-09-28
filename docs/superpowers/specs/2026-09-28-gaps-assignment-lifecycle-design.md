# Assignment lifecycle on /gaps: reassign, unassign, complete

Date: 2026-09-28
Status: draft v2 — awaiting review

## Problem

Mon's LDC mapmakers, after day one on /gaps:

> could we add functionality to de-/reassign tasks in the Gaps view? … would it
> be possible to include a Complete mechanism for said assignments?

/gaps can create an assignment but cannot change one. The obvious way to add
"Complete" — PATCH `status: done` — makes the work immediately reappear as
**unassigned High**: /gaps drops `done` assignments when mapping days to
owners, and silver only turns clean in a later snapshot, if the fix landed.
Someone could assign it twice.

## Decisions taken (2026-09-28, Angus)

1. **`cancelled` is the one new lifecycle status.** "Unassign" writes it.
   `blocked` keeps its meaning (genuinely stuck).
2. **"Awaiting snapshot" and "Reopened" are derived UI states** — computed,
   never written to the sheet.
3. **`assignment_id` is part of the run boundary.** Two adjacent assignments
   with the same assignee and status never merge.
4. **Actions operate on the whole assignment**, never the visible run.
5. **"My work" ships now**; bulk assign and claim do not.
6. **Everyone can do everything.** Any active team member can create,
   reassign, unassign, complete and reopen any assignment. Coordination is
   handled by Angus and Mon, not by permissions.
7. **Legacy `done` assignments are grandfathered.** The new lifecycle applies
   only to assignments completed under it. Nothing reopens on launch.
8. **Refresh timing is not assumed.** See "Silver refresh timing" — the
   design makes only claims that hold whatever the lag.

## Lifecycle model

Persisted `status`:

| status        | meaning                                   |
|---------------|-------------------------------------------|
| `queued`      | assigned, not started                     |
| `in_progress` | being worked                              |
| `blocked`     | stuck; needs a manager                    |
| `done`        | assignee says finished                    |
| `cancelled`   | **new** — withdrawn; days return to pool  |

`cancelled` is terminal in v1; re-assigning those days creates a new
assignment. Rows are never deleted (Sheets rule: soft-delete only).

### The cutoff: a server-stamped `completed_at` column

New column **O `completed_at`** on `assignments`, appended at the end so
existing rows keep positional alignment.

- The PATCH route stamps it **server-side** whenever status transitions
  *into* `done`, and clears it when status leaves `done` (e.g. Reopen).
  Completing again after a reopen stamps a fresh time. Reassigning a `done`
  assignment does not change its status, so it keeps its `completed_at`.
- It is never accepted from the client.
- Every existing `done` row has it blank. **A `done` row with blank
  `completed_at` is legacy and keeps today's behaviour exactly**: it does not
  own its days, so still-dirty days stay in the Unassigned queue where they
  are today. Launch changes nothing for legacy rows.

Why this over the alternatives:

| mechanism                                  | problem                                                                                              |
|--------------------------------------------|------------------------------------------------------------------------------------------------------|
| launch-date constant vs `updated_at`       | `updated_at` moves on any edit (notes, reassign), so touching a legacy row after launch would pull it into the lifecycle; also a hardcoded date |
| marker text in `notes`                     | user-editable free text; one edit breaks it                                                          |
| grandfather legacy rows as *owned* `done`  | would pull their still-dirty days **out** of today's Unassigned queue at launch — hiding real work   |
| **`completed_at` column**                  | explicit per row, set only by the new flow, survives unrelated edits                                 |

`completed_at` is also the right clock for "awaiting": comparing
`updated_at` would flip a done assignment back to awaiting whenever someone
edited its notes.

Grid and /queue completions go through the same PATCH route, so they stamp
`completed_at` too — "the new flow" means the server, not a particular page.

### Derived run state (pure function, `app/coverage/gaps.ts`)

```
runState(run, dataAsOf):
  run.assignment === null                         -> "unassigned"
  status in queued | in_progress | blocked        -> "active"
  status === done, completed_at >  dataAsOf       -> "awaiting_snapshot"
  status === done, classification === high        -> "reopened"
  status === done                                 -> "done"      (blackout)
```

- Legacy `done` and `cancelled` never reach this: they own no days.
- A `done` assignment whose days all became clean produces **no runs**. That
  is the success path.
- `reopened` is High only. Blackout has no silver, so no cleaner action can
  resolve it; Blackout days under `done` render as plain `done`.

## Silver refresh timing (traced 2026-09-28)

What the code and config establish:

- `vercel.json`: `/api/cron/snapshot` runs `0 * * * *` — top of every hour
  (Vercel cron is UTC).
- `fetchSilverCells` (`lib/snapshot/queries.ts:180`) reads
  `ais_silver_summary` live at cron time. No cache, no intermediate copy.
- `generated_at` is stamped **after** all queries finish
  (`lib/snapshot/build.ts:109`).
- **Nothing in this repo writes, refreshes or schedules
  `ais_silver_summary`** — no DDL, no materialized-view refresh, no job, no
  script. Every reference is a read (snapshot, `/api/progress`,
  `/api/snapshot/diag`, one admin route). No other local repo references it.
- Its writers are external: inserts are tagged `updated_by = 'data-platform'`;
  human edits stamp `updated_by` (db user id) and `updated_at`.

What cannot be established here: whether a human fix zeroes the four anomaly
counts immediately or through a later recompute, and on what cadence. The
privacy rule forbids checking against the database. It belongs to whoever
owns data-platform.

Design response — make no claim that depends on it:

- **`data_as_of`**: a new `CoveragePayload` field stamped immediately
  *before* the snapshot queries run. This removes the one race this repo does
  control (work completed mid-cron). Older snapshots without it fall back to
  `generated_at`.
- **Reopened is worded as an observation, not a verdict**: *"still dirty in
  the 14:00 snapshot, taken after this was completed"*. True whatever the
  upstream lag. If the lag turns out to be long, the fix is a grace period
  added then, with a known number — not guessed now.

## Run grouping

The owner lookup moves from `app/gaps/page.tsx` into `app/coverage/gaps.ts`:

```ts
type AssignmentRef = {
  id: string; assignee: string; status: string; completedAt: string;
  dateStart: string; dateEnd: string;
};
buildAssignmentIndex(rows, drafts): (rowIdx, date) => AssignmentRef | null
```

- Skips `cancelled` and legacy `done` (blank `completed_at`).
- Includes `done` with `completed_at` — the fix for the reappear bug.
- Overlapping assignments on one ship-day: first in sheet order wins (today's
  behaviour, now documented).

`GapRun.assignmentKey` becomes `GapRun.assignment: AssignmentRef | null`. A
run continues only while ship, classification, `assignment?.id` and
day-adjacency all hold.

## Full-assignment behaviour

An action targets an `assignment_id` and changes its **entire**
`[date_start, date_end]`. The run clicked is often only part of it:

| why the visible run is a subset             | example                                       |
|---------------------------------------------|-----------------------------------------------|
| date filter clips it                        | filter Mar–Apr, assignment Jan–Jun            |
| days inside it are already done             | clean silver / visible voyage splits the run  |
| days inside it are ineligible               | out-of-service or dead-COVID days             |
| classification changes inside it            | part High, part Blackout (different tables)   |
| an earlier overlapping assignment owns days | first-listed wins                             |

One assignment can therefore appear as several runs, across both tables.

1. Every run of an assignment shows the same actions; acting on any of them
   updates all of them together.
2. When the run ≠ the full range, the row shows **"part of 2024-01-01 →
   2024-06-30"** beside its own dates.
3. Every action confirms with the full range: *"Reassign 2024-01-01 →
   2024-06-30 (182 days) from Nick to Kim? 41 of those days are in this
   view."*
4. **No partial actions in v1.** To move part of an assignment, unassign it
   and create new ones for the sub-ranges. "Split" is out of scope.
5. Complete marks the whole range `done`, including already-clean and
   Blackout days. `done` is the assignee's claim; the next snapshot is the
   check, and only still-dirty High days come back as `reopened`.

## /gaps UI

**View selector** replaces the "unassigned only" checkbox:
`Unassigned · My work · Reopened · All` (default `Unassigned`). The assignee
dropdown still narrows `All`.

**Per-run actions** — the same for every signed-in team member:

| state             | actions                                  |
|-------------------|------------------------------------------|
| unassigned        | assign to…                               |
| active            | Reassign · Unassign · Mark complete      |
| awaiting_snapshot | Reassign · Unassign · Reopen (muted row) |
| reopened          | Reassign · Unassign · Reopen             |
| done (blackout)   | Reopen                                   |

*Reopen* = `in_progress`. *Unassign* = `cancelled`. Awaiting rows cannot be
assigned — that is what stops the double-assign. Errors surface in the
existing error line; no silent retries. On success the draft updates locally;
on failure assignments reload from the sheet.

## Permission model

One rule: **any active team member may create or change any assignment.**
Identity (`created_by`, `updated_by`, the cancel note) still comes from the
session, never the body.

- `lib/roles.ts` `canAssign` → any signed-in session whose slug is an active
  team member. Checked per request, not just at sign-in: sessions are JWTs,
  so Jen's and Jayziel's existing sessions stay valid until they expire even
  though they can no longer sign in. PATCH drops its cleaner schema and own-assignment check; one schema
  for everyone.
- `can_assign` becomes redundant. **Retire it** (team-config field, session
  type, `lib/auth.ts`, the allow-list test) rather than leave two gates that
  disagree.
- `role = assigner` stays — it still guards the admin and diag routes.
- The three client-side `canAssign` copies (grid, grid filter, /gaps) follow
  the server rule. The grid's `EditAssignmentModal` "assigner or own" check
  and /queue's `isAssigner` edit gates are **in scope** too: leaving them
  would give one permission model on /gaps and another on the grid.

**Conflicts with the repo's written rules**, to update in the same change:

- `.claude/rules/testing.md`: "Assigner-only routes reject cleaners. Cleaners
  can only PATCH assignments where `assignee === session.slug`."
- `learnings/2026-08-25-can-assign-capability.md` describes the retired gate;
  add a superseded note rather than delete it.

## Server changes (`PATCH /api/sheets/assignments/[id]`)

- `VALID_STATUSES` gains `cancelled`.
- Stamps / clears `completed_at` on transitions into / out of `done`.
- Reassign validates the assignee against active `TEAM_MEMBERS`, matching
  POST. Unknown or inactive → 400. (Today PATCH accepts a departed member.)
- Cancelling appends `cancelled by <slug> <date>` to notes, from the session.
- Audit `before` is populated with prior values of patched fields. Today it
  is always empty.
- Sheet reads and writes widen from `A:N` to `A:O` (PATCH, GET); POST appends
  a blank column O.

## Other consumers

- `app/queue/page.tsx` — `toStatus()` maps unknown strings to `queued`; add
  `cancelled` and exclude it from Active, Done and counts.
- `CoverageGrid.tsx` overlay and assignee filter — skip `cancelled` where
  they skip `done`. (Legacy vs new `done` does not matter to the grid; it
  already skips all `done`.)
- `CoverageGrid.tsx` `STATUS_OPTIONS` — unchanged; Unassign lives on /gaps.
- `DraftAssignment` gains `updated_at?`, `updated_by?`, `completed_at?`.
- `lib/sheets/schemas.ts` `ASSIGNMENTS_COLUMNS` gains `completed_at`;
  `docs/sheets-schema.md` updated (enum + column). **The live sheet's header
  row must get `completed_at` in O1 before deploy** — `/sync-sheet` will
  flag the mismatch otherwise.
- `CoveragePayload` gains `data_as_of`.

## Testing

`tests/coverage/gaps.test.ts`:
- Adjacent assignments, same assignee + status → two runs.
- `cancelled` leaves its days unassigned.
- Legacy `done` (blank `completed_at`) leaves its days unassigned — the
  grandfathering guarantee.
- New `done` keeps owning its days — the reappear bug.
- `runState`: awaiting vs reopened either side of `dataAsOf`; Blackout under
  `done` → `done`, never `reopened`.

`tests/api/assignments-patch.test.ts` (new; mocks `lib/sheets/client`):
- A cleaner can reassign, cancel and complete someone else's assignment → 200.
- Unauthenticated → 401; signed-in but not an active member → 403.
- Reassign to an inactive or unknown slug → 400. Bad status → 400.
- Transition into `done` stamps `completed_at`; leaving `done` clears it;
  a body-supplied `completed_at` is ignored.
- Cancel appends the note; audit `before` carries the old status.

`tests/lib/team-config.test.ts`: the `can_assign` allow-list test is replaced
by "every active member can assign".

Snapshot: a test that `data_as_of` is stamped before the queries run and is
≤ `generated_at`.

UI is verified manually in the browser, per `.claude/rules/testing.md`.

## Open questions

None blocking. One fact to collect, not assume: the upstream refresh cadence
of `ais_silver_summary` from its data-platform owner. It decides whether a
grace period is ever needed; the design is correct without it.

## Out of scope

Bulk assign, claim, splitting an assignment, ETags / concurrent-edit
protection (last-write-wins stays), notifications, surfacing the audit log.
