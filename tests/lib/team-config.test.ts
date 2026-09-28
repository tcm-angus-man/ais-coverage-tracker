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
