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
