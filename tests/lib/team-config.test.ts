import { describe, expect, it } from "vitest";
import { lookupTeamMember } from "../../lib/sheets/team-config";

// The assignment allow-list is keyed off the Google account email, and the
// slug is not always the email local-part (Ai-ai's slug is "ai-ai" but she
// signs in as aiai@). A drift between the two silently locks someone out of
// assigning, so pin the exact addresses that were granted the capability.
const GRANTED = [
  "aiai@thecruisemaps.com",
  "nick@thecruisemaps.com",
  "kim@thecruisemaps.com",
  "coleen@thecruisemaps.com",
  "rome@thecruisemaps.com",
];

describe("assignment allow-list", () => {
  it.each(GRANTED)("%s can assign without being promoted to assigner", async email => {
    const member = await lookupTeamMember(email);
    expect(member).not.toBeNull();
    expect(member?.can_assign).toBe(true);
    expect(member?.role).toBe("cleaner");
  });

  it("leaves other cleaners without the capability", async () => {
    const bea = await lookupTeamMember("bea@thecruisemaps.com");
    expect(bea?.role).toBe("cleaner");
    expect(bea?.can_assign).toBeUndefined();
  });

  it("still resolves the original assigners", async () => {
    expect((await lookupTeamMember("angus@thecruisemaps.com"))?.role).toBe("assigner");
    expect((await lookupTeamMember("mon@thecruisemaps.com"))?.role).toBe("assigner");
  });
});
