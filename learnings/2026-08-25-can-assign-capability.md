# Granting assignment rights without granting the assigner role

## Problem

Five cleaners (Ai-ai, Nick, Kim, Coleen, Rome) needed to hand out ship-days
themselves. The obvious move — flip `role` to `"assigner"` in
`lib/sheets/team-config.ts` — is a one-line-per-person change.

## Why the obvious move was wrong

`role === "assigner"` is a single flat check standing in for several unrelated
powers. Promoting a working cleaner would have:

- **Removed** the "Mark in progress / Mark done" button on their own queue rows
  (`app/queue/page.tsx` renders it under `!isAssigner`) and swapped their queue
  from "My Assignments" to every assignment.
- **Removed** the "Assigned to me" pill in the coverage grid, replacing it with
  the full team filter.
- **Granted** the admin routes: `/api/snapshot/rebuild`, `/api/snapshot/diag`,
  `/api/admin/ship-metadata-*`, `/api/debug-key`.

None of that was asked for, and the first two are regressions for people who
actively clean.

## Approach

Add a narrow capability alongside the role rather than widening the role.

1. `can_assign?: boolean` on `TeamMember`, set on the five.
2. Carried through the NextAuth `jwt` and `session` callbacks into
   `session.user.can_assign` (declared in `lib/types/session.ts`).
3. `canAssign(session)` in `lib/roles.ts` — `isAssigner(session) || can_assign`.
4. Applied at exactly two places: the `POST /api/sheets/assignments` gate, and
   the coverage grid's assign-modal trigger.

`isAssigner` was deliberately **left alone** for editing others' assignments,
so the client gate and the `PATCH` route still agree.

## Generalisable rule

When a request is "let person X do action A", check whether the existing role
that grants A also grants B and C. If it does, and X should not have B and C,
the fix is a capability flag, not a promotion. Grep every `role ===` site
before deciding — the side effects live in the UI, not just the route guards.

## Testing note

`lib/*` modules start with `import "server-only"`, which throws outside an RSC
bundle. `vitest.config.ts` now aliases `server-only` to `tests/stubs/server-only.ts`
so pure logic in those modules is testable at all. This unblocks testing
anything under `lib/`, not just roles.
