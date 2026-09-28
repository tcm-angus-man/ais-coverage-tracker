# Gaps Assignment Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any team member reassign, unassign (cancel), complete and reopen assignments from /gaps, without completed work reappearing as unassigned.

**Architecture:** One new persisted status (`cancelled`) and one new server-stamped column (`completed_at`, column O). Everything else is derived: a pure `runState()` in `app/coverage/gaps.ts` combines assignment status, `completed_at` and the snapshot's new `data_as_of` timestamp into `unassigned | active | awaiting_snapshot | reopened | done`. Gap runs split on `assignment_id`. Permissions collapse to one rule: any active team member may change any assignment.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, zod, googleapis (Sheets), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-gaps-assignment-lifecycle-design.md` (v2, approved 2026-09-28). Read it before starting; this plan argues from it.

## Prerequisite (before Task 1)

The Track A changes (silver cleanliness tile, newest-first sort, unified roster, Jen/Jayziel inactive) are **uncommitted** on `main`. Angus must approve committing them first, so the tasks below each commit only their own diff. Do not start Task 1 on a dirty tree.

## Global Constraints

- Production data never flows through the AI. Tests use synthetic fixtures only; never run `psql`, never read `tmp/` or snapshot JSON (`.claude/rules/data-privacy.md`).
- No ORMs. `googleapis` via `lib/sheets/client.ts` for Sheets.
- zod on every API route input; errors are `{ ok: false, error: string }` with the right HTTP status.
- Identity (`created_by`, `updated_by`, the actor in notes) comes from the session, never the request body.
- Never `clear` or delete Sheets rows. `cancelled` is a soft delete.
- Notes are append-only; each entry is prefixed `[<slug> @ <ISO>]\n` (`docs/sheets-schema.md`).
- New Sheets columns are appended at the end (`completed_at` is column **O**, index 14). Ranges widen from `A:N` to `A:O`.
- Server components by default; no HTML `<form>`; strict TS, no `any`.
- Client surfaces the `error` string; no silent retries.
- UI is verified manually in the browser, not by tests (`.claude/rules/testing.md`).
- Build verification: `NODE_ENV=production npm run build` (the shell exports `NODE_ENV=development`, which fails `/404` prerender spuriously).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Legacy rows shorter than column O** (written before this change, 14 cells) — PATCH must pad them and treat the missing cell as blank `completed_at`. Pinned in Task 2.
2. **Sheets reformatting a timestamp** (`USER_ENTERED` can turn an ISO string into something `Date.parse` rejects) — an unparseable `completed_at` must compare as older than the snapshot (→ `reopened`/`done`), never throw or stick at awaiting. Pinned in Task 4.
3. **A snapshot from before this change** has no `data_as_of` — fall back to `generated_at`. Pinned in Task 4.
4. **Notes edit and cancel in one PATCH** — the cancel entry appends to the *new* notes, and audit `before` holds the *original* notes. Pinned in Task 2.
5. **Blank `status` cell** (empty string, not undefined) — must behave as `queued`, not as an unknown status. Pinned in Task 4.

---

### Task 1: One permission rule — any active team member

**Files:**
- Modify: `lib/roles.ts:17-21`
- Modify: `lib/sheets/team-config.ts` (drop `can_assign` from the type and every entry)
- Modify: `lib/types/session.ts` (drop `can_assign`)
- Modify: `lib/auth.ts` (drop the three `can_assign` lines)
- Modify: `app/coverage/team.ts` (add `isTeamRole`)
- Modify: `app/coverage/CoverageGrid.tsx:184-187`, `:1029-1036`, `:1485-1499`, `:1573`
- Modify: `app/gaps/page.tsx:45`
- Modify: `app/queue/page.tsx` (DraftDetail edit gates)
- Modify: `.claude/rules/testing.md:9`, `learnings/2026-08-25-can-assign-capability.md` (top)
- Test: `tests/lib/roles.test.ts` (rewrite), `tests/lib/team-config.test.ts` (drop allow-list), `tests/coverage/team.test.ts` (add `isTeamRole`)

**Interfaces:**
- Produces: `canAssign(session: Session | null): boolean` — true iff the session's slug is an **active** `TEAM_MEMBERS` entry with role `assigner` or `cleaner`. Used by POST (unchanged call site) and PATCH (Task 2).
- Produces: `isTeamRole(role: string | undefined): boolean` in `app/coverage/team.ts` — client-side gate (role only; the server does the active check).

- [ ] **Step 1: Rewrite `tests/lib/roles.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { Session } from "next-auth";
import { canAssign, isAssigner } from "../../lib/roles";

// One rule for assignment writes: any ACTIVE team member may create or change
// any assignment. Coordination is handled by Angus and Mon, not permissions.
// The active check is per request because sessions are JWTs: a departed
// member's existing token keeps its old role until it expires.
function session(user: Partial<Session["user"]>): Session {
  return {
    expires: "2099-01-01T00:00:00.000Z",
    user: { slug: null, role: "viewer", db_user_id: null, display_name: null, ...user },
  } as Session;
}

describe("canAssign", () => {
  it("allows an assigner", () => {
    expect(canAssign(session({ role: "assigner", slug: "mon" }))).toBe(true);
  });

  it("allows any cleaner — no per-person capability flag any more", () => {
    expect(canAssign(session({ role: "cleaner", slug: "bea" }))).toBe(true);
  });

  it("refuses a departed member whose stale token still says cleaner", () => {
    expect(canAssign(session({ role: "cleaner", slug: "jen" }))).toBe(false);
  });

  it("refuses a viewer (signed in on the domain but not on the team)", () => {
    expect(canAssign(session({ role: "viewer", slug: null }))).toBe(false);
  });

  it("refuses a slug that is not on the team at all", () => {
    expect(canAssign(session({ role: "cleaner", slug: "nobody" }))).toBe(false);
  });

  it("refuses when there is no session", () => {
    expect(canAssign(null)).toBe(false);
  });

  // role=assigner still guards the admin and diag routes; widening assignment
  // writes must not widen those.
  it("does not make a cleaner an assigner", () => {
    expect(isAssigner(session({ role: "cleaner", slug: "nick" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Replace the allow-list block in `tests/lib/team-config.test.ts`**

Delete the `GRANTED` constant and the `describe("assignment allow-list", …)` block entirely. Replace with:

```ts
import { describe, expect, it } from "vitest";
import { lookupTeamMember } from "../../lib/sheets/team-config";

describe("team lookup", () => {
  // Ai-ai's slug is "ai-ai" but she signs in as aiai@ — a drift between the
  // two silently locks her out.
  it("resolves a member whose email local-part differs from the slug", async () => {
    expect((await lookupTeamMember("aiai@thecruisemaps.com"))?.slug).toBe("ai-ai");
  });

  it("still resolves the original assigners", async () => {
    expect((await lookupTeamMember("angus@thecruisemaps.com"))?.role).toBe("assigner");
    expect((await lookupTeamMember("mon@thecruisemaps.com"))?.role).toBe("assigner");
  });
});
```

- [ ] **Step 3: Add to `tests/coverage/team.test.ts`**

Change the import to `import { ASSIGNABLE_MEMBERS, LIVE_DATA_TEAM, ROSTER_GROUPS, isTeamRole } from "../../app/coverage/team";` and append:

```ts
describe("isTeamRole", () => {
  // The client-side gate for every assignment control. Viewers are signed in
  // on the domain but are not on the team.
  it("is true for assigners and cleaners, false for viewers and missing roles", () => {
    expect(isTeamRole("assigner")).toBe(true);
    expect(isTeamRole("cleaner")).toBe(true);
    expect(isTeamRole("viewer")).toBe(false);
    expect(isTeamRole(undefined)).toBe(false);
  });
});
```

- [ ] **Step 4: Run and confirm failures**

Run: `npm run test -- tests/lib tests/coverage/team.test.ts`
Expected: FAIL — `canAssign` refuses `bea` (no `can_assign`), accepts nothing new; `isTeamRole` is not exported. Also a TS/type complaint is fine at this stage.

- [ ] **Step 5: Implement**

`lib/roles.ts` — add the import and replace `canAssign`:

```ts
import { TEAM_MEMBERS } from "@/lib/sheets/team-config";

// Assignment writes (POST and PATCH). Any active team member may create or
// change any assignment. Checked per request against TEAM_MEMBERS because
// sessions are JWTs: a departed member's token keeps its old role until it
// expires. Does NOT imply admin-route access — that stays isAssigner.
export function canAssign(session: Session | null): boolean {
  const slug = session?.user?.slug;
  const role = session?.user?.role;
  if (!slug || (role !== "assigner" && role !== "cleaner")) return false;
  return TEAM_MEMBERS.some(m => m.slug === slug && m.active);
}
```

`lib/sheets/team-config.ts` — delete the `can_assign?: boolean;` field and its comment from `TeamMember`, and remove `, can_assign: true` from every entry (Coleen, Kim, Nick, Ai-ai, Rome). Keep Ai-ai's `email_local: "aiai"`.

`lib/types/session.ts` — delete `can_assign` (and its comment) from both `Session.user` and `JWT`.

`lib/auth.ts` — delete `token.can_assign = member.can_assign ?? false;`, `token.can_assign = false;`, and `can_assign: (token.can_assign as boolean | undefined) ?? false,`.

`app/coverage/team.ts` — append:

```ts
/** Client-side gate for assignment controls. The server also checks the member is active. */
export function isTeamRole(role: string | undefined): boolean {
  return role === "assigner" || role === "cleaner";
}
```

`app/coverage/CoverageGrid.tsx`:
- Import: `import { ROSTER_GROUPS, isTeamRole } from "./team";`
- Lines 184-187 become:

```ts
  // Any team member may create or edit any assignment (one permission rule,
  // enforced server-side by lib/roles canAssign).
  const canAssign = isTeamRole(session?.user?.role);
```

- At the `<EditAssignmentModal` call (~line 1029), replace `isAssigner={isAssigner}` and `currentSlug={session?.user?.slug ?? ""}` with `canEdit={canAssign}`.
- In `EditAssignmentModal`'s signature and prop type, replace `isAssigner, currentSlug` / `isAssigner: boolean; currentSlug: string;` with `canEdit` / `canEdit: boolean;`, and delete the line `const canEdit = isAssigner || assignment.assignee === currentSlug;`.
- In `AssigneeFilterSelect` (~line 1573): `const canAssign = isTeamRole(session?.user?.role);`

`app/gaps/page.tsx:45`: `const canAssign = isTeamRole(session?.user?.role);` and add `isTeamRole` to the `@/app/coverage/team` import.

`app/queue/page.tsx`:
- Import `isTeamRole` alongside `ASSIGNABLE_MEMBERS, LIVE_DATA_TEAM`.
- In `QueuePage`, after `const isAssigner = …`, add `const canEdit = isTeamRole(me?.role);`
- Add `canEdit={canEdit}` where `<DraftDetail` is rendered, add `canEdit` to its destructured props and `canEdit: boolean;` to its prop type.
- Inside `DraftDetail`, change the three edit gates from `isAssigner` to `canEdit`: the status `{isAssigner ? (<select …` ternary, `{isAssigner && !editingNotes && (` and `{isAssigner && editingNotes ? (`. Leave every other `isAssigner` use (list scope, "All Assignments" header, row advance button, empty-state copy) unchanged — those are view scope, not permission.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all PASS; no references to `can_assign` remain — confirm with `grep -rn "can_assign" app lib tests` (expect no output).

- [ ] **Step 7: Update the written rules**

`.claude/rules/testing.md` line 9 becomes:

```md
- **API route role gating.** Assignment routes (POST/PATCH) accept any active team member and reject viewers, unknown slugs and departed members (stale JWTs). Admin routes stay assigner-only.
```

Prepend to `learnings/2026-08-25-can-assign-capability.md`:

```md
> **Superseded 2026-09-28.** `can_assign` was retired: any active team member
> may now create or change any assignment (see
> `docs/superpowers/specs/2026-09-28-gaps-assignment-lifecycle-design.md`).
> The reasoning below about not promoting cleaners to `assigner` still holds —
> `role` is unchanged and still guards the admin routes.
```

- [ ] **Step 8: Commit**

```bash
git add lib/roles.ts lib/sheets/team-config.ts lib/types/session.ts lib/auth.ts app/coverage/team.ts app/coverage/CoverageGrid.tsx app/gaps/page.tsx app/queue/page.tsx .claude/rules/testing.md learnings/2026-08-25-can-assign-capability.md tests/lib/roles.test.ts tests/lib/team-config.test.ts tests/coverage/team.test.ts
git commit -m "feat(assignments): any active team member may assign; retire can_assign

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: PATCH lifecycle — `cancelled`, `completed_at`, audit `before`

**Files:**
- Create: `lib/sheets/notes.ts`
- Modify: `lib/sheets/schemas.ts` (append `completed_at` to `ASSIGNMENTS_COLUMNS`)
- Modify: `app/api/sheets/assignments/[id]/route.ts` (full rewrite of `PATCH`)
- Modify: `app/api/sheets/assignments/route.ts` (POST: range `A:O`, blank column O)
- Modify: `app/api/sheets/assignments/get/route.ts` (range `A:O`, return `completed_at`)
- Modify: `docs/sheets-schema.md`
- Test: `tests/api/assignments-patch.test.ts` (create)

**Interfaces:**
- Consumes: `canAssign` (Task 1).
- Produces: `appendNote(existing: string, actor: string, at: string, text: string): string` in `lib/sheets/notes.ts`.
- Produces: PATCH success body `{ ok: true, updated: { status: string; assignee: string; notes: string; completed_at: string; updated_at: string; updated_by: string } }` — the values actually written. Task 6 applies these to the local draft.
- Produces: GET assignments include `completed_at: string`.

- [ ] **Step 1: Write the failing tests** — create `tests/api/assignments-patch.test.ts`:

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ASSIGNMENTS_COLUMNS } from "@/lib/sheets/schemas";

// Sheets and the session are mocked; rows are synthetic (data-privacy rule).
const getServerSession = vi.fn();
vi.mock("next-auth/next", () => ({ getServerSession: (...a: unknown[]) => getServerSession(...a) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
const sheetsGet = vi.fn();
const sheetsAppend = vi.fn();
const sheetsUpdateRow = vi.fn();
vi.mock("@/lib/sheets/client", () => ({
  sheetsGet: (...a: unknown[]) => sheetsGet(...a),
  sheetsAppend: (...a: unknown[]) => sheetsAppend(...a),
  sheetsUpdateRow: (...a: unknown[]) => sheetsUpdateRow(...a),
}));

import { PATCH } from "@/app/api/sheets/assignments/[id]/route";

type Column = (typeof ASSIGNMENTS_COLUMNS)[number];
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-28T10:00:00.000Z";
const BASE: Record<Column, string> = {
  assignment_id: ID, created_at: "2026-09-01T00:00:00.000Z", created_by: "mon",
  ship_mmsi: "200000001", ship_name: "Ship A", cruise_line: "Line",
  date_start: "2024-01-01", date_end: "2024-01-31", assignee: "nick",
  status: "queued", notes: "", updated_at: "2026-09-01T00:00:00.000Z",
  updated_by: "mon", ship_id: "1", completed_at: "",
};
const rowOf = (over: Partial<Record<Column, string>> = {}) =>
  ASSIGNMENTS_COLUMNS.map(c => ({ ...BASE, ...over })[c]);
const givenRow = (row: string[]) => sheetsGet.mockResolvedValue([[...ASSIGNMENTS_COLUMNS], row]);
const written = () => sheetsUpdateRow.mock.calls[0][1] as string[];
const cell = (row: string[], c: Column) => row[ASSIGNMENTS_COLUMNS.indexOf(c)];
const audit = () => sheetsAppend.mock.calls[0][1][0] as string[];

const BEA = { slug: "bea", role: "cleaner", db_user_id: "11", display_name: "Bea" };

async function call(body: unknown, user: object | null = BEA) {
  getServerSession.mockResolvedValue(user ? { expires: "2099-01-01", user } : null);
  const req = new Request(`http://localhost/api/sheets/assignments/${ID}`, { method: "PATCH", body: JSON.stringify(body) });
  const res = await PATCH(req, { params: { id: ID } });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  [getServerSession, sheetsGet, sheetsAppend, sheetsUpdateRow].forEach(m => m.mockReset());
  sheetsAppend.mockResolvedValue(undefined);
  sheetsUpdateRow.mockResolvedValue(undefined);
  givenRow(rowOf());
});
afterEach(() => { vi.useRealTimers(); });

describe("PATCH /api/sheets/assignments/[id] — permissions", () => {
  // One rule: any active team member may change any assignment.
  it("lets a cleaner reassign someone else's assignment", async () => {
    const { status } = await call({ assignee: "kim" });
    expect(status).toBe(200);
    expect(cell(written(), "assignee")).toBe("kim");
  });

  it("rejects an unauthenticated request", async () => {
    expect((await call({ status: "done" }, null)).status).toBe(401);
  });

  it("rejects a departed member's stale session", async () => {
    const { status } = await call({ status: "done" }, { slug: "jen", role: "cleaner" });
    expect(status).toBe(403);
    expect(sheetsUpdateRow).not.toHaveBeenCalled();
  });
});

describe("PATCH — validation", () => {
  it.each(["jen", "nobody"])("rejects reassigning to %s (inactive or unknown)", async slug => {
    const { status, json } = await call({ assignee: slug });
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(sheetsUpdateRow).not.toHaveBeenCalled();
  });

  it("rejects an unknown status", async () => {
    expect((await call({ status: "archived" })).status).toBe(400);
  });

  it("returns 404 for an id not in the sheet", async () => {
    givenRow(rowOf({ assignment_id: "22222222-2222-4222-8222-222222222222" }));
    expect((await call({ status: "done" })).status).toBe(404);
  });
});

describe("PATCH — completed_at is owned by the server", () => {
  // completed_at is the cutoff that separates new-flow completions from
  // grandfathered legacy done rows, so only the server may set it.
  it("stamps completed_at when status moves into done", async () => {
    await call({ status: "done" });
    expect(cell(written(), "completed_at")).toBe(NOW);
  });

  it("ignores a completed_at supplied in the body", async () => {
    await call({ status: "in_progress", completed_at: "2020-01-01T00:00:00.000Z" });
    expect(cell(written(), "completed_at")).toBe("");
  });

  it("clears completed_at when status leaves done", async () => {
    givenRow(rowOf({ status: "done", completed_at: "2026-09-27T09:00:00.000Z" }));
    await call({ status: "in_progress" });
    expect(cell(written(), "completed_at")).toBe("");
  });

  it("keeps completed_at when a done assignment is only reassigned", async () => {
    givenRow(rowOf({ status: "done", completed_at: "2026-09-27T09:00:00.000Z" }));
    await call({ assignee: "kim" });
    expect(cell(written(), "completed_at")).toBe("2026-09-27T09:00:00.000Z");
  });

  it("stamps a fresh time when completed again after a reopen", async () => {
    givenRow(rowOf({ status: "in_progress", completed_at: "" }));
    await call({ status: "done" });
    expect(cell(written(), "completed_at")).toBe(NOW);
  });

  // Review focus 1: rows written before column O existed have 14 cells.
  it("pads a legacy 14-cell row and writes all 15 columns", async () => {
    givenRow(rowOf({ status: "done" }).slice(0, 14));
    await call({ status: "in_progress" });
    expect(written()).toHaveLength(15);
    expect(cell(written(), "completed_at")).toBe("");
    expect(sheetsUpdateRow.mock.calls[0][0]).toBe("assignments!A2:O2");
  });
});

describe("PATCH — cancel and audit", () => {
  it("cancelling appends an attributed note and keeps existing notes", async () => {
    givenRow(rowOf({ notes: "[mon @ 2026-09-01T00:00:00.000Z]\nstart with Q1" }));
    await call({ status: "cancelled" });
    expect(cell(written(), "status")).toBe("cancelled");
    expect(cell(written(), "notes")).toBe(
      `[mon @ 2026-09-01T00:00:00.000Z]\nstart with Q1\n\n[bea @ ${NOW}]\ncancelled`,
    );
  });

  // Review focus 4: notes edit + cancel in one request.
  it("appends the cancel note to the new notes, and audits the original notes", async () => {
    await call({ notes: "moved to Kim's batch", status: "cancelled" });
    expect(cell(written(), "notes")).toBe(`moved to Kim's batch\n\n[bea @ ${NOW}]\ncancelled`);
    expect(JSON.parse(audit()[5]).notes).toBe("");
  });

  it("records the previous values in audit `before`", async () => {
    await call({ status: "in_progress" });
    const row = audit();
    expect(row[1]).toBe("bea");
    expect(row[2]).toBe("update");
    expect(JSON.parse(row[5])).toEqual({ status: "queued" });
    expect(JSON.parse(row[6])).toEqual({ status: "in_progress" });
  });

  it("returns the values it wrote so the client can apply them", async () => {
    const { json } = await call({ status: "done" });
    expect(json).toEqual({
      ok: true,
      updated: { status: "done", assignee: "nick", notes: "", completed_at: NOW, updated_at: NOW, updated_by: "bea" },
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- tests/api/assignments-patch.test.ts`
Expected: FAIL — `ASSIGNMENTS_COLUMNS` has no `completed_at` (15-cell assertions fail), cancelled rejected as bad status, cleaner reassign rejected by the old cleaner schema.

- [ ] **Step 3: Add the column** — in `lib/sheets/schemas.ts`, after `"ship_id",` add:

```ts
  // Column O. Stamped server-side by PATCH when status moves into `done`,
  // cleared when it leaves. Blank on a `done` row = legacy completion,
  // grandfathered out of the awaiting/reopened lifecycle.
  "completed_at",
```

- [ ] **Step 4: Create `lib/sheets/notes.ts`**

```ts
// Notes are append-only; each entry is prefixed "[<slug> @ <ISO>]\n"
// (docs/sheets-schema.md). Lives outside the route file because Next route
// modules may only export HTTP handlers and route config.
export function appendNote(existing: string, actor: string, at: string, text: string): string {
  const entry = `[${actor} @ ${at}]\n${text}`;
  return existing ? `${existing}\n\n${entry}` : entry;
}
```

- [ ] **Step 5: Rewrite `app/api/sheets/assignments/[id]/route.ts`**

```ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sheetsGet, sheetsAppend, sheetsUpdateRow } from "@/lib/sheets/client";
import { ASSIGNMENTS_COLUMNS } from "@/lib/sheets/schemas";
import { TEAM_MEMBERS } from "@/lib/sheets/team-config";
import { appendNote } from "@/lib/sheets/notes";
import { canAssign } from "@/lib/roles";
import { z } from "zod";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["queued", "in_progress", "done", "blocked", "cancelled"] as const;

// One schema for every team member — any active member may change any
// assignment. completed_at is deliberately absent: the server owns it.
// zod strips unknown keys, so a body-supplied completed_at is ignored.
const PatchSchema = z.object({
  status:   z.enum(VALID_STATUSES).optional(),
  assignee: z.string().min(1).optional(),
  notes:    z.string().optional(),
});

type Column = (typeof ASSIGNMENTS_COLUMNS)[number];
const col = (c: Column) => ASSIGNMENTS_COLUMNS.indexOf(c);

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }
    if (!canAssign(session)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
    }
    const patch = parsed.data;

    // Same check as POST: never write an assignee the team doesn't have.
    if (patch.assignee !== undefined && !TEAM_MEMBERS.some(m => m.slug === patch.assignee && m.active)) {
      return NextResponse.json({ ok: false, error: `Unknown assignee: ${patch.assignee}` }, { status: 400 });
    }

    const actor = session.user.slug ?? "unknown";
    const rows = await sheetsGet("assignments!A:O");
    // rows[0] is the header; data starts at sheet row 2
    const dataRows = rows.slice(1);
    const rowIndex = dataRows.findIndex(r => r[col("assignment_id")] === params.id);
    if (rowIndex === -1) {
      return NextResponse.json({ ok: false, error: "assignment not found" }, { status: 404 });
    }
    const sheetRow = rowIndex + 2;

    // Pad legacy rows written before column O existed.
    const updated = [...dataRows[rowIndex]];
    while (updated.length < ASSIGNMENTS_COLUMNS.length) updated.push("");

    const now = new Date().toISOString();
    const before: Partial<Record<Column, string>> = {};
    const after: Partial<Record<Column, string>> = {};
    const set = (c: Column, value: string) => {
      if (!(c in before)) before[c] = updated[col(c)] ?? "";
      updated[col(c)] = value;
      after[c] = value;
    };

    const prevStatus = updated[col("status")] || "queued";
    if (patch.assignee !== undefined) set("assignee", patch.assignee);
    if (patch.notes !== undefined) set("notes", patch.notes);
    if (patch.status !== undefined) {
      set("status", patch.status);
      if (patch.status === "done" && prevStatus !== "done") set("completed_at", now);
      if (patch.status !== "done" && prevStatus === "done") set("completed_at", "");
      if (patch.status === "cancelled" && prevStatus !== "cancelled") {
        set("notes", appendNote(updated[col("notes")] ?? "", actor, now, "cancelled"));
      }
    }
    updated[col("updated_at")] = now;
    updated[col("updated_by")] = actor;

    await sheetsUpdateRow(`assignments!A${sheetRow}:O${sheetRow}`, updated);

    // Audit log (best-effort, per .claude/rules/sheets-integration.md)
    const auditRow = [
      now,
      actor,
      "update",
      params.id,
      Object.keys(after).join(","),
      JSON.stringify(before),
      JSON.stringify(after),
    ];
    sheetsAppend("audit_log!A:G", [auditRow]).catch(e =>
      console.error("[PATCH assignments] audit append failed:", e),
    );

    return NextResponse.json({
      ok: true,
      updated: {
        status: updated[col("status")] || "queued",
        assignee: updated[col("assignee")] ?? "",
        notes: updated[col("notes")] ?? "",
        completed_at: updated[col("completed_at")] ?? "",
        updated_at: now,
        updated_by: actor,
      },
    });
  } catch (err) {
    console.error("[PATCH /api/sheets/assignments/[id]]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 6: Widen POST and GET**

`app/api/sheets/assignments/route.ts`: after `d.ship_id,` in `assignmentRow` add `"",               // completed_at`, and change `sheetsAppend("assignments!A:N", …)` to `"assignments!A:O"`.

`app/api/sheets/assignments/get/route.ts`: change `sheetsGet("assignments!A:N")` to `"assignments!A:O"` and add after the `updated_by` line:

```ts
        completed_at: row[ASSIGNMENTS_COLUMNS.indexOf("completed_at")] ?? "",
```

- [ ] **Step 7: Run tests**

Run: `npm run test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 8: Update `docs/sheets-schema.md`**

In the `assignments` table: change the `status` row to `` `queued` \| `in_progress` \| `done` \| `blocked` \| `cancelled` `` and add rows after `updated_by`:

```md
| `ship_id` | integer | Authoritative ship key. Blank on legacy rows (resolved by `ship_mmsi`). |
| `completed_at` | ISO datetime | Column O. Server-stamped when status moves into `done`; cleared when it leaves. Blank on a `done` row = legacy completion. |
```

Replace the **Status transitions** paragraph with:

```md
**Status transitions.** Any active team member may set any status on any assignment. `cancelled` withdraws an assignment (soft delete; its days return to the pool) and appends an attributed `cancelled` note. The /gaps UI never moves an assignment out of `cancelled`. "Awaiting snapshot" and "reopened" are derived in the UI from `status`, `completed_at` and the snapshot's `data_as_of`; they are never stored.
```

- [ ] **Step 9: Commit**

```bash
git add lib/sheets/schemas.ts lib/sheets/notes.ts "app/api/sheets/assignments/[id]/route.ts" app/api/sheets/assignments/route.ts app/api/sheets/assignments/get/route.ts docs/sheets-schema.md tests/api/assignments-patch.test.ts
git commit -m "feat(assignments): cancelled status, server-stamped completed_at, audit before

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Snapshot `data_as_of`

**Files:**
- Modify: `app/coverage/types.ts` (`CoveragePayload`)
- Modify: `lib/snapshot/build.ts:38-46`, `:109-111`
- Test: `tests/snapshot/build.test.ts` (create)

**Interfaces:**
- Produces: `CoveragePayload.data_as_of?: string` — ISO time captured immediately before the snapshot queries run. Optional because snapshots written before this change lack it.

- [ ] **Step 1: Write the failing test** — create `tests/snapshot/build.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

// Every dependency is mocked: no Postgres, no Blob, no Sheets.
const captured: { payload?: Record<string, unknown> } = {};
const T0 = new Date("2026-09-28T10:00:00.000Z");
const T1 = new Date("2026-09-28T10:04:00.000Z");

vi.mock("@/lib/snapshot/db", () => ({ getPool: () => ({}), endPool: vi.fn() }));
vi.mock("@/lib/snapshot/queries", () => ({
  // The queries take time; simulate it by moving the clock forward.
  fetchShips: () => { vi.setSystemTime(T1); return Promise.resolve([]); },
  fetchVoyageCells: () => Promise.resolve([]),
  fetchSilverCells: () => Promise.resolve([]),
  buildDateAxis: () => ["2026-09-28"],
}));
vi.mock("@/lib/snapshot/compress", () => ({
  compressJson: (p: Record<string, unknown>) => { captured.payload = p; return Promise.resolve(Buffer.from("x")); },
}));
vi.mock("@/lib/snapshot/blob", () => ({ putCoverageBlob: () => Promise.resolve({}) }));
vi.mock("@/lib/sheets/ship-metadata", () => ({
  fetchShipMetadataUncached: () => Promise.resolve([]),
  indexByVessel: () => new Map(), indexByMmsi: () => new Map(), indexByImo: () => new Map(),
  vesselKey: () => "",
}));

import { buildSnapshot } from "@/lib/snapshot/build";

afterEach(() => { vi.useRealTimers(); });

describe("buildSnapshot", () => {
  // /gaps compares an assignment's completed_at against data_as_of to decide
  // "awaiting snapshot" vs "reopened". generated_at is stamped after the
  // queries, so work completed mid-cron would look reopened. data_as_of must
  // be the time BEFORE the queries read Postgres.
  it("stamps data_as_of before the queries run, and generated_at after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);

    await buildSnapshot();

    expect(captured.payload?.data_as_of).toBe(T0.toISOString());
    expect(captured.payload?.generated_at).toBe(T1.toISOString());
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- tests/snapshot/build.test.ts`
Expected: FAIL — `data_as_of` is `undefined`.

- [ ] **Step 3: Implement**

`app/coverage/types.ts` — in `CoveragePayload`, after `generated_at: string;`:

```ts
  /**
   * When the snapshot queries started reading Postgres. /gaps compares
   * assignment completion against this, not generated_at (stamped after the
   * queries finish). Absent on snapshots written before 2026-09-28.
   */
  data_as_of?: string;
```

`lib/snapshot/build.ts` — first line of `buildSnapshot()` body, before `const pool = getPool();`:

```ts
  // Stamped before any query reads Postgres — see CoveragePayload.data_as_of.
  const data_as_of = new Date().toISOString();
```

and in the payload literal, after `generated_at,` add `data_as_of,`.

- [ ] **Step 4: Run tests**

Run: `npm run test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/coverage/types.ts lib/snapshot/build.ts tests/snapshot/build.test.ts
git commit -m "feat(snapshot): stamp data_as_of before the queries run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gap-run lifecycle logic (pure, `app/coverage/gaps.ts`)

**Files:**
- Modify: `app/coverage/gaps.ts`
- Modify: `app/gaps/page.tsx:59-84`, `:116-118`, `:329` (minimal migration so it compiles; UI comes in Task 6)
- Test: `tests/coverage/gaps.test.ts`

**Interfaces:**
- Produces (all exported from `app/coverage/gaps.ts`):
  - `type AssignmentRef = { id: string; assignee: string; status: string; completedAt: string; dateStart: string; dateEnd: string }`
  - `type AssignmentLike = { id: string; ship_id: number; ship_mmsi: number; date_start: string; date_end: string; assignee?: string; status?: string; completed_at?: string }`
  - `ownsDays(a: Pick<AssignmentLike, "status" | "completed_at">): boolean`
  - `buildAssignmentIndex(rows: Row[], assignments: AssignmentLike[]): (rowIdx: number, date: string) => AssignmentRef | null`
  - `GapRun.assignment: AssignmentRef | null` (**replaces** `assignmentKey`)
  - `BuildGapRunsArgs.assignmentAt?: (rowIdx: number, date: string) => AssignmentRef | null`
  - `type RunState = "unassigned" | "active" | "awaiting_snapshot" | "reopened" | "done"`
  - `runState(run: Pick<GapRun, "assignment" | "classification">, dataAsOf: string): RunState`
  - `snapshotAsOf(p: { data_as_of?: string; generated_at: string }): string`
  - `type GapView = "unassigned" | "mine" | "reopened" | "all"`
  - `inView(run: Pick<GapRun, "assignment">, state: RunState, view: GapView, mySlug: string): boolean`
  - `type RunAction = "assign" | "reassign" | "unassign" | "complete" | "reopen"`
  - `actionsFor(state: RunState): RunAction[]`
  - `spanDays(ref: Pick<AssignmentRef, "dateStart" | "dateEnd">): number`
  - `visibleDays(assignmentId: string, runs: GapRun[]): number`
  - `confirmText(a: { verb: string; ref: AssignmentRef; visible: number; detail?: string }): string`

- [ ] **Step 1: Write the failing tests**

In `tests/coverage/gaps.test.ts`, extend the import:

```ts
import {
  actionsFor, buildAssignmentIndex, buildGapRuns, classifyGapDay, confirmText, gapTotals, inView,
  matchesShipQuery, ownsDays, runState, snapshotAsOf, sortGapRuns, spanDays, visibleDays,
  type AssignmentLike, type AssignmentRef, type GapRun,
} from "../../app/coverage/gaps";
```

Replace the existing test `"splits a run when the assignment identity changes"` (it uses the removed string key) with:

```ts
  it("splits a run when the assignment identity changes", () => {
    const kim: AssignmentRef = { id: "a1", assignee: "kim", status: "in_progress", completedAt: "", dateStart: "2024-01-01", dateEnd: "2024-01-02" };
    const runs = buildGapRuns({
      ...base([review(), review(), review(), review()], [silverBad(), silverBad(), silverBad(), silverBad()]),
      assignmentAt: (_r, date) => (date <= "2024-01-02" ? kim : null),
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ days: 2, assignment: { id: "a1" } });
    expect(runs[1]).toMatchObject({ days: 2, assignment: null });
  });
```

Append at the end of the file:

```ts
const assignment = (over: Partial<AssignmentLike> = {}): AssignmentLike => ({
  id: "a1", ship_id: 1, ship_mmsi: 200000001, date_start: "2024-01-01", date_end: "2024-01-04",
  assignee: "nick", status: "queued", completed_at: "", ...over,
});
const ref = (over: Partial<AssignmentRef> = {}): AssignmentRef => ({
  id: "a1", assignee: "nick", status: "queued", completedAt: "", dateStart: "2024-01-01", dateEnd: "2024-01-04", ...over,
});
const runWith = (a: AssignmentRef | null, classification: "high" | "blackout" = "high") =>
  ({ assignment: a, classification }) as Pick<GapRun, "assignment" | "classification">;
const SNAP = "2026-09-28T10:00:00.000Z";

describe("ownsDays", () => {
  it("claims days for live statuses and new-flow done", () => {
    expect(ownsDays({ status: "queued" })).toBe(true);
    expect(ownsDays({ status: "blocked" })).toBe(true);
    expect(ownsDays({ status: "done", completed_at: "2026-09-28T09:00:00.000Z" })).toBe(true);
  });

  // Cancelled = withdrawn; its days go back to the pool.
  it("releases a cancelled assignment's days", () => {
    expect(ownsDays({ status: "cancelled" })).toBe(false);
  });

  // The grandfathering guarantee: legacy done rows behave exactly as today,
  // so their still-dirty days stay in the Unassigned queue at launch.
  it("releases a legacy done assignment (blank completed_at)", () => {
    expect(ownsDays({ status: "done", completed_at: "" })).toBe(false);
    expect(ownsDays({ status: "done" })).toBe(false);
  });

  // Review focus 5: an empty status cell is "", not undefined.
  it("treats a blank status cell as queued", () => {
    expect(ownsDays({ status: "" })).toBe(true);
  });
});

describe("buildAssignmentIndex", () => {
  const rows = [row(ship())];

  it("resolves a day inside an assignment to its ref", () => {
    const at = buildAssignmentIndex(rows, [assignment()]);
    expect(at(0, "2024-01-02")).toMatchObject({ id: "a1", assignee: "nick", status: "queued" });
    expect(at(0, "2024-01-05")).toBeNull();
  });

  it("normalises a blank status to queued", () => {
    expect(buildAssignmentIndex(rows, [assignment({ status: "" })])(0, "2024-01-01")?.status).toBe("queued");
  });

  it("skips cancelled and legacy done assignments", () => {
    const at = buildAssignmentIndex(rows, [
      assignment({ id: "c", status: "cancelled" }),
      assignment({ id: "l", status: "done", completed_at: "" }),
    ]);
    expect(at(0, "2024-01-01")).toBeNull();
  });

  // The reappear bug: a completed assignment must keep owning its days.
  it("keeps a new-flow done assignment owning its days", () => {
    const at = buildAssignmentIndex(rows, [assignment({ status: "done", completed_at: SNAP })]);
    expect(at(0, "2024-01-01")?.id).toBe("a1");
  });

  it("gives an overlapping day to the first assignment in sheet order", () => {
    const at = buildAssignmentIndex(rows, [assignment({ id: "first" }), assignment({ id: "second" })]);
    expect(at(0, "2024-01-02")?.id).toBe("first");
  });

  it("ignores an assignment for a ship not in the snapshot", () => {
    const at = buildAssignmentIndex(rows, [assignment({ ship_id: 999, ship_mmsi: 999 })]);
    expect(at(0, "2024-01-01")).toBeNull();
  });
});

describe("buildGapRuns with assignment identity", () => {
  // Decision 3: two adjacent assignments with the same assignee and status
  // must stay two runs, or an action on one would silently hit the other.
  it("never merges adjacent assignments with the same assignee and status", () => {
    const at = buildAssignmentIndex([row(ship())], [
      assignment({ id: "x", date_start: "2024-01-01", date_end: "2024-01-02" }),
      assignment({ id: "y", date_start: "2024-01-03", date_end: "2024-01-04" }),
    ]);
    const runs = buildGapRuns({
      rowIdxs: [0], rows: [row(ship())], dates: days(4),
      voyageCells: [[review(), review(), review(), review()]],
      silverCells: [[silverBad(), silverBad(), silverBad(), silverBad()]],
      assignmentAt: at,
    });
    expect(runs.map(r => r.assignment?.id)).toEqual(["x", "y"]);
  });
});

describe("runState", () => {
  it("is unassigned without an assignment", () => {
    expect(runState(runWith(null), SNAP)).toBe("unassigned");
  });

  it("is active for queued, in_progress and blocked", () => {
    for (const status of ["queued", "in_progress", "blocked"]) {
      expect(runState(runWith(ref({ status })), SNAP)).toBe("active");
    }
  });

  // Completed after the snapshot read Postgres: the snapshot cannot know yet.
  it("is awaiting_snapshot when completed after data_as_of", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "2026-09-28T10:30:00.000Z" })), SNAP)).toBe("awaiting_snapshot");
  });

  // A snapshot taken after completion still shows this High day dirty.
  it("is reopened when completed before data_as_of and still High", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "2026-09-28T09:00:00.000Z" })), SNAP)).toBe("reopened");
  });

  // Blackout has no silver to clean, so it can never be "still dirty".
  it("is done, never reopened, for Blackout under a done assignment", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "2026-09-28T09:00:00.000Z" }), "blackout"), SNAP)).toBe("done");
  });

  // Review focus 2: Sheets can reformat a timestamp into something unparseable.
  it("treats an unparseable completed_at as older than the snapshot", () => {
    expect(runState(runWith(ref({ status: "done", completedAt: "28/09/2026 10:30" })), SNAP)).toBe("reopened");
  });
});

describe("snapshotAsOf", () => {
  it("prefers data_as_of", () => {
    expect(snapshotAsOf({ data_as_of: "2026-09-28T10:00:00.000Z", generated_at: "2026-09-28T10:04:00.000Z" })).toBe("2026-09-28T10:00:00.000Z");
  });

  // Review focus 3: snapshots written before data_as_of existed.
  it("falls back to generated_at on an older snapshot", () => {
    expect(snapshotAsOf({ generated_at: "2026-09-28T10:04:00.000Z" })).toBe("2026-09-28T10:04:00.000Z");
  });
});

describe("inView", () => {
  const mine = runWith(ref({ assignee: "kim" }));
  it("Unassigned shows only unassigned runs", () => {
    expect(inView(runWith(null), "unassigned", "unassigned", "kim")).toBe(true);
    expect(inView(mine, "active", "unassigned", "kim")).toBe(false);
  });
  it("My work shows runs assigned to the viewer, in any state", () => {
    expect(inView(mine, "reopened", "mine", "kim")).toBe(true);
    expect(inView(mine, "active", "mine", "nick")).toBe(false);
    expect(inView(runWith(null), "unassigned", "mine", "")).toBe(false);
  });
  it("Reopened shows only reopened runs", () => {
    expect(inView(mine, "reopened", "reopened", "kim")).toBe(true);
    expect(inView(mine, "awaiting_snapshot", "reopened", "kim")).toBe(false);
  });
  it("All shows everything", () => {
    expect(inView(runWith(null), "unassigned", "all", "")).toBe(true);
  });
});

describe("actionsFor", () => {
  // The spec's per-state action table.
  it("matches the lifecycle table", () => {
    expect(actionsFor("unassigned")).toEqual(["assign"]);
    expect(actionsFor("active")).toEqual(["reassign", "unassign", "complete"]);
    expect(actionsFor("awaiting_snapshot")).toEqual(["reassign", "unassign", "reopen"]);
    expect(actionsFor("reopened")).toEqual(["reassign", "unassign", "reopen"]);
    expect(actionsFor("done")).toEqual(["reopen"]);
  });

  // Awaiting runs must not be assignable — that is what stops the double-assign.
  it("never offers assign on a run that already has an assignment", () => {
    for (const s of ["active", "awaiting_snapshot", "reopened", "done"] as const) {
      expect(actionsFor(s)).not.toContain("assign");
    }
  });
});

describe("full-assignment confirmation", () => {
  it("counts the inclusive span of the whole assignment", () => {
    expect(spanDays({ dateStart: "2024-01-01", dateEnd: "2024-06-30" })).toBe(182);
    expect(spanDays({ dateStart: "2024-01-01", dateEnd: "2024-01-01" })).toBe(1);
  });

  it("counts only the visible days belonging to that assignment", () => {
    const runs = [
      { assignment: ref({ id: "a1" }), days: 3 },
      { assignment: ref({ id: "a1" }), days: 2 },
      { assignment: ref({ id: "b2" }), days: 9 },
      { assignment: null, days: 4 },
    ] as GapRun[];
    expect(visibleDays("a1", runs)).toBe(5);
  });

  // Actions change the WHOLE assignment; the text must say so even when the
  // clicked run is a small part of it.
  it("states the full range, the change, and how much of it is in view", () => {
    expect(confirmText({
      verb: "Reassign", ref: ref({ dateStart: "2024-01-01", dateEnd: "2024-06-30" }), visible: 41, detail: "from Nick to Kim",
    })).toBe("Reassign 2024-01-01 → 2024-06-30 (182 days) from Nick to Kim? 41 of those days are in this view.");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run test -- tests/coverage/gaps.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement in `app/coverage/gaps.ts`**

In `GapRun`, replace the `assignmentKey` field and its comment with:

```ts
  /** The assignment owning this run's days, or null when unassigned. */
  assignment: AssignmentRef | null;
```

In `BuildGapRunsArgs`, replace the `assignmentAt` type with:

```ts
  assignmentAt?: (rowIdx: number, date: string) => AssignmentRef | null;
```

In `buildGapRuns`, replace `const key = …` with:

```ts
      const ref = cls === null ? null : (assignmentAt?.(si, date) ?? null);
```

replace `open.assignmentKey === key &&` with `(open.assignment?.id ?? null) === (ref?.id ?? null) &&`, and in the new-run literal replace `assignmentKey: key,` with `assignment: ref,`.

Add, above `classifyGapDay`:

```ts
export type AssignmentRef = {
  id: string;
  assignee: string;
  status: string;
  /** Server-stamped completion time; blank unless status is a new-flow `done`. */
  completedAt: string;
  dateStart: string;
  dateEnd: string;
};

/** The assignment fields the index reads. DraftAssignment satisfies it. */
export type AssignmentLike = {
  id: string;
  ship_id: number;
  ship_mmsi: number;
  date_start: string;
  date_end: string;
  assignee?: string;
  status?: string;
  completed_at?: string;
};

/**
 * Whether an assignment claims its days on /gaps. Cancelled ones were
 * withdrawn. Legacy `done` rows (blank completed_at) are grandfathered: they
 * keep the pre-lifecycle behaviour of not owning their days, so their
 * still-dirty days stay in the Unassigned queue instead of all reopening at
 * launch. An empty status cell reads as "", which means queued.
 */
export function ownsDays(a: Pick<AssignmentLike, "status" | "completed_at">): boolean {
  const status = a.status || "queued";
  if (status === "cancelled") return false;
  if (status === "done" && !a.completed_at) return false;
  return true;
}

/**
 * Ship-day -> owning assignment. Overlapping assignments on one day: the
 * first in sheet order wins. Overlap is a data smell, not a feature.
 */
export function buildAssignmentIndex(
  rows: Row[],
  assignments: AssignmentLike[],
): (rowIdx: number, date: string) => AssignmentRef | null {
  const rowIdxByShipId = new Map<number, number>();
  const rowIdxByMmsi = new Map<number, number>();
  rows.forEach((row, i) => {
    for (const m of row.members) rowIdxByShipId.set(m.id, i);
    if (row.mmsi > 0 && !rowIdxByMmsi.has(row.mmsi)) rowIdxByMmsi.set(row.mmsi, i);
  });

  const byRow = new Map<number, AssignmentRef[]>();
  for (const a of assignments) {
    if (!a.date_start || !a.date_end || !ownsDays(a)) continue;
    // ship_id is authoritative; legacy rows carry 0 and resolve by MMSI.
    const ri = a.ship_id ? rowIdxByShipId.get(a.ship_id) : (a.ship_mmsi ? rowIdxByMmsi.get(a.ship_mmsi) : undefined);
    if (ri === undefined) continue;
    const list = byRow.get(ri) ?? [];
    list.push({
      id: a.id,
      assignee: a.assignee ?? "",
      status: a.status || "queued",
      completedAt: a.completed_at ?? "",
      dateStart: a.date_start,
      dateEnd: a.date_end,
    });
    byRow.set(ri, list);
  }

  return (rowIdx, date) => {
    for (const r of byRow.get(rowIdx) ?? []) if (date >= r.dateStart && date <= r.dateEnd) return r;
    return null;
  };
}

export type RunState = "unassigned" | "active" | "awaiting_snapshot" | "reopened" | "done";

/**
 * Derived lifecycle state — never persisted. `reopened` is an observation,
 * not a verdict: a snapshot that read Postgres after completion still shows
 * the day dirty. It says nothing about why (the fix may not have landed, or
 * ais_silver_summary may refresh behind the cron — that cadence is external
 * and unknown). High only: Blackout has no silver, so it is `done`.
 */
export function runState(run: Pick<GapRun, "assignment" | "classification">, dataAsOf: string): RunState {
  const a = run.assignment;
  if (!a) return "unassigned";
  if (a.status !== "done") return "active";
  // An unparseable completed_at (Sheets reformatting) compares as older.
  const completed = Date.parse(a.completedAt);
  if (!Number.isNaN(completed) && completed > Date.parse(dataAsOf)) return "awaiting_snapshot";
  return run.classification === "high" ? "reopened" : "done";
}

/** The snapshot's data time: data_as_of, or generated_at on older snapshots. */
export function snapshotAsOf(p: { data_as_of?: string; generated_at: string }): string {
  return p.data_as_of || p.generated_at;
}

export type GapView = "unassigned" | "mine" | "reopened" | "all";

export function inView(run: Pick<GapRun, "assignment">, state: RunState, view: GapView, mySlug: string): boolean {
  switch (view) {
    case "unassigned": return state === "unassigned";
    case "mine":       return mySlug !== "" && run.assignment?.assignee === mySlug;
    case "reopened":   return state === "reopened";
    case "all":        return true;
  }
}

export type RunAction = "assign" | "reassign" | "unassign" | "complete" | "reopen";

/** The spec's per-state action table. Every team member gets the same actions. */
export function actionsFor(state: RunState): RunAction[] {
  switch (state) {
    case "unassigned":        return ["assign"];
    case "active":            return ["reassign", "unassign", "complete"];
    case "awaiting_snapshot": return ["reassign", "unassign", "reopen"];
    case "reopened":          return ["reassign", "unassign", "reopen"];
    case "done":              return ["reopen"];
  }
}

/** Inclusive day count of an assignment's full range. */
export function spanDays(ref: Pick<AssignmentRef, "dateStart" | "dateEnd">): number {
  const ms = Date.parse(`${ref.dateEnd}T00:00:00Z`) - Date.parse(`${ref.dateStart}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Days of one assignment that appear in the given runs (the current view). */
export function visibleDays(assignmentId: string, runs: GapRun[]): number {
  let n = 0;
  for (const r of runs) if (r.assignment?.id === assignmentId) n += r.days;
  return n;
}

/**
 * Confirmation for an action. Actions change the WHOLE assignment, and the
 * visible run is often only part of it (date filter, already-clean days,
 * ineligible days, a High/Blackout split), so the text states the full range.
 */
export function confirmText(a: { verb: string; ref: AssignmentRef; visible: number; detail?: string }): string {
  const range = `${a.ref.dateStart} → ${a.ref.dateEnd} (${spanDays(a.ref)} days)`;
  return `${a.verb} ${range}${a.detail ? ` ${a.detail}` : ""}? ${a.visible} of those days are in this view.`;
}
```

- [ ] **Step 4: Migrate `app/gaps/page.tsx` just enough to compile**

Replace the whole `assignmentAt` `useMemo` (lines 59-84) with:

```ts
  // Ship-day -> owning assignment; runs split on assignment_id.
  const assignmentAt = useMemo(
    () => (indexed ? buildAssignmentIndex(indexed.rows, drafts) : undefined),
    [indexed, drafts],
  );
```

Add `buildAssignmentIndex` to the `@/app/coverage/gaps` import. Change the `visible` predicate to:

```ts
    const visible = (r: GapRun) =>
      (!unassignedOnly || r.assignment === null) &&
      (!assignee || r.assignment?.assignee === assignee);
```

In `RunTable`, change `r.assignmentKey ? r.assignmentKey.replace("|", " · ") : ""` to `r.assignment ? \`${r.assignment.assignee} · ${r.assignment.status}\` : ""` and `r.assignmentKey === null` to `r.assignment === null`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all PASS; `grep -rn "assignmentKey" app tests` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add app/coverage/gaps.ts app/gaps/page.tsx tests/coverage/gaps.test.ts
git commit -m "feat(gaps): split runs on assignment_id and derive lifecycle state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Teach the other status consumers `cancelled`

UI-only; no tests per `.claude/rules/testing.md`. Verified by typecheck and in Task 7's manual pass.

**Files:**
- Modify: `app/coverage/AssignmentContext.tsx` (type fields + `updateDraft`)
- Modify: `app/coverage/CoverageGrid.tsx:248`, `:278`
- Modify: `app/queue/page.tsx` (`Status`, `toStatus`, colours/labels, list filtering)

**Interfaces:**
- Produces: `DraftAssignment` gains `updated_at?: string; updated_by?: string; completed_at?: string;`
- Produces: `useAssignments().updateDraft(id: string, patch: Partial<DraftAssignment>): void` — merges into the local draft. Task 6 uses it.

- [ ] **Step 1: `AssignmentContext.tsx`**

Add to `DraftAssignment` after `created_by?: string;`:

```ts
  updated_at?: string;
  updated_by?: string;
  /** Server-stamped when status moves into done; blank on legacy done rows. */
  completed_at?: string;
```

Add `updateDraft: (id: string, patch: Partial<DraftAssignment>) => void;` to `Ctx`, `updateDraft: () => {},` to the default context value, and in the provider:

```ts
  // Apply the values the PATCH route reports it wrote (never guessed locally).
  const updateDraft = useCallback((id: string, patch: Partial<DraftAssignment>) => {
    setDrafts(prev => prev.map(x => (x.id === id ? { ...x, ...patch } : x)));
  }, []);
```

and pass `updateDraft` in the provider `value`.

- [ ] **Step 2: Grid** — `CoverageGrid.tsx:248` becomes `if (status === "done" || status === "cancelled") continue;` and line 278's condition becomes `if ((a.assignee ?? "") !== assigneeFilter || a.status === "done" || a.status === "cancelled") continue;`

- [ ] **Step 3: Queue** — in `app/queue/page.tsx`:
- `type Status = "queued" | "in_progress" | "done" | "blocked" | "cancelled";`
- Add `cancelled` entries to `STATUS_COLORS` (use `C_INK_FAINT`'s value `"#5a6d7c"`) and `STATUS_LABEL` (`cancelled: "Cancelled"`). Leave `ALL_STATUSES` as the four existing statuses — Unassign lives on /gaps.
- `toStatus`: `if (s === "in_progress" || s === "done" || s === "blocked" || s === "cancelled") return s;`
- Directly after `const { drafts, loading, reload } = useAssignments();` add:

```ts
  // Cancelled assignments were withdrawn; they are nobody's work any more.
  const liveDrafts = useMemo(() => drafts.filter(d => toStatus(d.status) !== "cancelled"), [drafts]);
```

- Use `liveDrafts` instead of `drafts` in `assigneeSlugs`, in both branches of `visibleDrafts`, and in the per-person `count={…}`. Keep `selDraft = drafts.find(…)` on `drafts`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/coverage/AssignmentContext.tsx app/coverage/CoverageGrid.tsx app/queue/page.tsx
git commit -m "feat(assignments): grid and queue treat cancelled as withdrawn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: /gaps lifecycle UI

UI-only; no tests per `.claude/rules/testing.md`. All logic it uses is tested in Task 4.

**Files:**
- Modify: `app/gaps/page.tsx`

**Interfaces:**
- Consumes: Task 4 exports; `updateDraft`, `reload` (Task 5); PATCH `updated` body (Task 2); `snapshotAsOf`; `ROSTER_GROUPS`, `ASSIGNABLE_MEMBERS`, `isTeamRole`.

- [ ] **Step 1: State and derived data**

- Imports: add `actionsFor, confirmText, inView, runState, snapshotAsOf, visibleDays, type GapView, type RunAction` from `@/app/coverage/gaps`; `ASSIGNABLE_MEMBERS` from `@/app/coverage/team`.
- `const { drafts, addDraft, updateDraft, reload } = useAssignments();`
- Replace `const [unassignedOnly, setUnassignedOnly] = useState(true);` with `const [view, setView] = useState<GapView>("unassigned");`
- Rename `canAssign` to `canAct` (`const canAct = isTeamRole(session?.user?.role);`) and add `const mySlug = session?.user?.slug ?? "";`
- `const dataAsOf = payload ? snapshotAsOf(payload) : "";`
- In the main `useMemo`, replace `visible` and the return with:

```ts
    const visible = (r: GapRun) =>
      inView(r, runState(r, dataAsOf), view, mySlug) &&
      (view !== "all" || !assignee || r.assignment?.assignee === assignee);
    return {
      runs,
      high: runs.filter(r => r.classification === "high" && visible(r)),
      blackout: runs.filter(r => r.classification === "blackout"),
      totals: t,
      silver: silverKpis,
    };
```

  Add `runs: [] as GapRun[]` to the early-return object, destructure `runs` too, and replace `unassignedOnly` in the dependency array with `view, mySlug, dataAsOf`.

- [ ] **Step 2: The action handler** — add below `assignRun`:

```ts
  // Every action changes the WHOLE assignment; confirmText says so.
  async function actOnRun(run: GapRun, action: RunAction, to?: string) {
    const a = run.assignment;
    if (!a) return;
    const name = (slug: string) => ASSIGNABLE_MEMBERS.find(m => m.slug === slug)?.display_name ?? slug;
    const plan =
      action === "reassign" && to ? { verb: "Reassign", detail: `from ${name(a.assignee)} to ${name(to)}`, patch: { assignee: to } } :
      action === "unassign"       ? { verb: "Unassign", detail: `from ${name(a.assignee)}`, patch: { status: "cancelled" } } :
      action === "complete"       ? { verb: "Mark complete", patch: { status: "done" } } :
      action === "reopen"         ? { verb: "Reopen", patch: { status: "in_progress" } } :
      null;
    if (!plan) return;
    if (!window.confirm(confirmText({ verb: plan.verb, ref: a, visible: visibleDays(a.id, runs), detail: plan.detail }))) return;
    setBusy(a.id);
    try {
      const r = await fetch(`/api/sheets/assignments/${a.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan.patch),
      }).then(res => res.json());
      if (!r.ok) { setError(r.error ?? "assignment update failed"); reload(); return; }
      // Apply exactly what the server wrote, including the completed_at it stamped.
      updateDraft(a.id, r.updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      reload();
    } finally {
      setBusy(null);
    }
  }
```

- [ ] **Step 3: View selector** — replace the `<label>…unassigned only</label>` block with:

```tsx
            <div style={{ display: "flex", gap: 3 }}>
              {([["unassigned", "Unassigned"], ["mine", "My work"], ["reopened", "Reopened"], ["all", "All"]] as const).map(([v, label]) => {
                const on = view === v;
                return (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    style={{ padding: "3px 10px", fontSize: 10, cursor: "pointer", borderRadius: 2, fontFamily: "inherit", fontWeight: on ? 600 : 400, border: `1px solid ${on ? C_ACCENT : C_LINE}`, background: on ? C_ACCENT : "transparent", color: on ? "#1a1207" : C_INK_FAINT }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
```

  Render the existing assignee `<select>` only when `view === "all"` (wrap it in `{view === "all" && (…)}`).

- [ ] **Step 4: Table props** — the two `RunTable` usages become:

```tsx
        <RunTable runs={high} dataAsOf={dataAsOf} allowAssign canAct={canAct} busy={busy} onAssign={assignRun} onAction={actOnRun} />
```

```tsx
        {showBlackout ? <RunTable runs={blackout} dataAsOf={dataAsOf} allowAssign={false} canAct={canAct} busy={busy} onAssign={undefined} onAction={actOnRun} /> : null}
```

- [ ] **Step 5: Rewrite `RunTable`**

```tsx
function RunTable({ runs, dataAsOf, allowAssign, canAct, busy, onAssign, onAction }: {
  runs: GapRun[];
  dataAsOf: string;
  allowAssign: boolean;
  canAct: boolean;
  busy: string | null;
  onAssign?: (r: GapRun, who: string) => void;
  onAction: (r: GapRun, action: RunAction, to?: string) => void;
}) {
  if (runs.length === 0) {
    return <div style={{ fontSize: 11, color: C_INK_FAINT, padding: "8px 0" }}>Nothing here.</div>;
  }
  const snapTime = dataAsOf ? new Date(dataAsOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const selectStyle: React.CSSProperties = { width: 96, padding: "2px 6px", fontSize: 10, cursor: "pointer", borderRadius: 2, border: `1px solid ${C_LINE}`, fontFamily: "inherit" };
  return (
    <div style={{ border: `1px solid ${C_LINE}`, borderRadius: 3, overflow: "hidden" }}>
      {runs.slice(0, 500).map(r => {
        const key = `${r.rowIdx}|${r.dateStart}`;
        const a = r.assignment;
        const state = runState(r, dataAsOf);
        const actions = actionsFor(state).filter(x => allowAssign || x !== "assign");
        const partial = a !== null && (a.dateStart !== r.dateStart || a.dateEnd !== r.dateEnd);
        const label =
          !a ? "" :
          state === "awaiting_snapshot" ? `${a.assignee} · done · awaiting snapshot` :
          state === "reopened" ? `${a.assignee} · reopened` :
          `${a.assignee} · ${a.status.replace("_", " ")}`;
        const labelTitle = state === "reopened"
          ? `Still dirty in the ${snapTime} snapshot, taken after this was completed.`
          : undefined;
        return (
          <div
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 14, padding: "7px 12px", borderBottom: `1px solid ${C_LINE}`, background: C_PANEL, fontSize: 11.5, opacity: state === "awaiting_snapshot" ? 0.55 : 1 }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 1, background: r.classification === "high" ? C_HIGH : C_BLACKOUT, flexShrink: 0 }} />
            <span style={{ flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.shipName}</span>
            <span style={{ width: 190, flexShrink: 0, color: C_INK_FAINT, fontSize: 10, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              MMSI {r.mmsi > 0 ? r.mmsi : "—"} · IMO {r.imo || "—"}
            </span>
            <span style={{ color: C_INK_DIM, fontVariantNumeric: "tabular-nums" }}>
              {r.dateStart} → {r.dateEnd}
              {partial && a && <span style={{ color: C_INK_FAINT, fontSize: 10 }}> · part of {a.dateStart} → {a.dateEnd}</span>}
            </span>
            <span style={{ color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", width: 52, textAlign: "right" }}>{r.days}d</span>
            <span title={labelTitle} style={{ width: 170, textAlign: "right", color: state === "reopened" ? C_ACCENT : C_INK_FAINT, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {label}
            </span>
            {canAct && onAssign && actions.includes("assign") ? (
              <select
                value=""
                disabled={busy === key}
                onChange={e => { const v = e.target.value; e.currentTarget.value = ""; if (v) onAssign(r, v); }}
                style={{ ...selectStyle, background: C_ACCENT, color: "#1a1207", fontWeight: 600 }}
              >
                <option value="">{busy === key ? "…" : "assign to…"}</option>
                {ROSTER_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.members.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
                  </optgroup>
                ))}
              </select>
            ) : canAct && a && actions.length > 0 ? (
              <select
                value=""
                disabled={busy === a.id}
                onChange={e => {
                  const v = e.target.value;
                  e.currentTarget.value = "";
                  if (!v) return;
                  const [act, to] = v.split(":");
                  onAction(r, act as RunAction, to);
                }}
                style={{ ...selectStyle, background: "transparent", color: C_INK_DIM }}
              >
                <option value="">{busy === a.id ? "…" : "actions…"}</option>
                {actions.includes("complete") && <option value="complete">Mark complete</option>}
                {actions.includes("reopen") && <option value="reopen">Reopen</option>}
                {actions.includes("unassign") && <option value="unassign">Unassign</option>}
                {actions.includes("reassign") && ROSTER_GROUPS.map(g => (
                  <optgroup key={g.label} label={`Reassign to · ${g.label}`}>
                    {g.members.filter(m => m.slug !== a.assignee).map(m => (
                      <option key={m.slug} value={`reassign:${m.slug}`}>{m.display_name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : <span style={{ width: 96 }} />}
          </div>
        );
      })}
      {runs.length > 500 && (
        <div style={{ padding: "7px 12px", fontSize: 10.5, color: C_INK_FAINT, background: C_PANEL }}>
          showing first 500 of {runs.length.toLocaleString()} runs — narrow with the filters above
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm run test && NODE_ENV=production npm run build`
Expected: all PASS, "Compiled successfully".

- [ ] **Step 7: Commit**

```bash
git add app/gaps/page.tsx
git commit -m "feat(gaps): reassign, unassign, complete and reopen from the worklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pre-deploy step and manual verification

No code. This is the launch gate.

- [ ] **Step 1 (manual, Angus — before deploy): add the header.** In the live workbook's `assignments` tab, type `completed_at` into cell **O1**. Leave every data cell in column O blank — blank is what grandfathers the legacy `done` rows. Then run `/sync-sheet` and confirm `assignments` reports no mismatch.

- [ ] **Step 2: Deploy** per `/deploy`.

- [ ] **Step 3: Manual browser pass** (Angus or Mon; the AI must not view real data):
  1. /gaps loads; the view selector defaults to **Unassigned**; the Unassigned High count matches what it was before deploy (legacy `done` rows are grandfathered — nothing should have moved).
  2. **Reopened** is empty on launch day.
  3. Assign a run → it leaves Unassigned; in **All** it shows `name · queued`.
  4. Reassign it → the confirm dialog shows the full range, the from/to names and the in-view day count; the label updates without a reload.
  5. Mark complete → the row goes muted, "done · awaiting snapshot", and does **not** reappear in Unassigned.
  6. After the next hourly snapshot: the run either disappears (silver clean) or appears under **Reopened** with the snapshot time in its tooltip.
  7. Unassign → the run returns to Unassigned; the sheet row shows `cancelled` and a `[slug @ time]\ncancelled` note; /queue no longer lists it; the grid overlay no longer paints it.
  8. Sign in as a cleaner (not Angus/Mon): all of the above actions are available.
  9. With a date filter that clips an assignment, the row shows "part of <full range>" and the confirm text still states the full range.

---

## Self-review (done while writing)

- **Spec coverage:** decision 1 → Task 2; 2 → Task 4 `runState`; 3 → Task 4 run boundary; 4 → Task 4 `confirmText` + Task 6; 5 → Task 4 `inView` + Task 6; 6 → Task 1; 7 → Task 2 stamping + Task 4 `ownsDays` + Task 7 step 1; 8 → Task 3 + Task 4 wording. Server changes → Task 2. Other consumers → Task 5. Docs → Tasks 1, 2. The spec's "Snapshot: data_as_of ≤ generated_at" test → Task 3.
- **Deviation from spec, deliberately:** PATCH returns the written values and the client applies them (Task 2 `updated`, Task 6). The spec said "the draft updates locally"; doing that by mirroring the stamping rule on the client would duplicate server logic, and a naive local update would briefly treat a fresh completion as a legacy `done` (blank `completed_at`) and flash the run back into Unassigned.
- **Second deviation:** the spec's cancel note "cancelled by <slug> <date>" is written in the notes column's existing append-only format, `[<slug> @ <ISO>]\ncancelled` — same information, one notes convention.
- **Type consistency:** `AssignmentRef.completedAt` (camel, client ref) vs `completed_at` (snake, sheet/draft/API) is intentional and matches the existing `dateStart`/`date_start` split.
