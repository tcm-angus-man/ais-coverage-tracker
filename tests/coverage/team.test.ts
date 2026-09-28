import { describe, expect, it } from "vitest";
import { ASSIGNABLE_MEMBERS, LIVE_DATA_TEAM, ROSTER_GROUPS, isTeamRole } from "../../app/coverage/team";
import { TEAM_MEMBERS, lookupTeamMember } from "../../lib/sheets/team-config";

const slugs = (g: { members: { slug: string }[] }) => g.members.map(m => m.slug);

describe("assignee roster", () => {
  // Every dropdown in the product renders these groups in this order, so the
  // live-data team is always the first thing an assigner sees.
  it("groups Live Data Cleaning, then Team, then Manager", () => {
    expect(ROSTER_GROUPS.map(g => g.label)).toEqual(["Live Data Cleaning", "Team", "Manager"]);
    expect(slugs(ROSTER_GROUPS[0])).toEqual(["nick", "ai-ai", "kim"]);
    expect(slugs(ROSTER_GROUPS[2])).toEqual(["mon", "angus"]);
  });

  it("keeps the live-data set in step with the first group", () => {
    expect([...LIVE_DATA_TEAM]).toEqual(slugs(ROSTER_GROUPS[0]));
  });

  it("offers each member once", () => {
    const all = ASSIGNABLE_MEMBERS.map(m => m.slug);
    expect(new Set(all).size).toBe(all.length);
  });

  it("no longer offers departed members", () => {
    const all = ASSIGNABLE_MEMBERS.map(m => m.slug);
    expect(all).not.toContain("jen");
    expect(all).not.toContain("jayziel");
  });

  // Rich was never in an assignment dropdown; consolidating the roster must not
  // quietly add him.
  it("leaves Rich out", () => {
    expect(ASSIGNABLE_MEMBERS.map(m => m.slug)).not.toContain("rich");
  });

  // POST /api/sheets/assignments rejects any assignee that is not an active
  // team member. A dropdown entry the server refuses is a dead button.
  it("offers only members the assignment route will accept", () => {
    for (const m of ASSIGNABLE_MEMBERS) {
      expect(TEAM_MEMBERS.find(t => t.slug === m.slug && t.active), m.slug).toBeDefined();
    }
  });
});

describe("departed members", () => {
  it.each(["jen", "jayziel"])("%s can no longer sign in", async slug => {
    expect(await lookupTeamMember(`${slug}@thecruisemaps.com`)).toBeNull();
  });
});

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
