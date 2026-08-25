import { describe, expect, it } from "vitest";
import type { Session } from "next-auth";
import { canAssign, isAssigner } from "../../lib/roles";

// canAssign is the gate on POST /api/sheets/assignments. It exists because
// some cleaners hand out ship-days themselves, and we did NOT want to promote
// them to "assigner" — that role also unlocks the admin routes and swaps the
// queue page out of its cleaner affordances. If these two ever collapse back
// into one check, that separation has been lost.
function session(user: Partial<Session["user"]>): Session {
  return {
    expires: "2099-01-01T00:00:00.000Z",
    user: {
      slug: null,
      role: "viewer",
      db_user_id: null,
      display_name: null,
      can_assign: false,
      ...user,
    },
  } as Session;
}

describe("canAssign", () => {
  it("allows assigners, who could already assign before can_assign existed", () => {
    expect(canAssign(session({ role: "assigner", slug: "angus" }))).toBe(true);
  });

  it("allows a cleaner carrying can_assign — the whole point of the flag", () => {
    expect(canAssign(session({ role: "cleaner", slug: "nick", can_assign: true }))).toBe(true);
  });

  it("refuses a plain cleaner, so the flag is opt-in per person", () => {
    expect(canAssign(session({ role: "cleaner", slug: "bea" }))).toBe(false);
  });

  it("refuses a viewer even if a stale token claims can_assign", () => {
    expect(canAssign(session({ role: "viewer", can_assign: false }))).toBe(false);
  });

  it("refuses when there is no session", () => {
    expect(canAssign(null)).toBe(false);
  });

  it("does not make a can_assign cleaner an assigner — admin routes stay shut", () => {
    const nick = session({ role: "cleaner", slug: "nick", can_assign: true });
    expect(canAssign(nick)).toBe(true);
    expect(isAssigner(nick)).toBe(false);
  });
});
