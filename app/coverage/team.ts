// Client-safe team roster. Lives here rather than in lib/sheets/team-config.ts
// because that module is "server-only"; shared by the grid's assign modal, the
// grid's assignee filter, /gaps and /queue so there is one roster, not four.

export type RosterMember = { slug: string; display_name: string };
export type RosterGroup = { label: string; members: RosterMember[] };

// Every assignee dropdown renders these groups in this order. Rich is an
// assigner but has never been offered as an assignee, so he is not listed.
export const ROSTER_GROUPS: RosterGroup[] = [
  {
    label: "Live Data Cleaning",
    members: [
      { slug: "nick",   display_name: "Nick" },
      { slug: "ai-ai",  display_name: "Ai-ai" },
      { slug: "kim",    display_name: "Kim" },
    ],
  },
  {
    label: "Team",
    members: [
      { slug: "bea",    display_name: "Bea" },
      { slug: "ronnel", display_name: "Ronnel" },
      { slug: "kaye",   display_name: "Kaye" },
      { slug: "coleen", display_name: "Coleen" },
      { slug: "nicole", display_name: "Nicole" },
      { slug: "rome",   display_name: "Rome" },
      { slug: "dave",   display_name: "Dave" },
      { slug: "jovi",   display_name: "Jovi" },
    ],
  },
  {
    label: "Manager",
    members: [
      { slug: "mon",    display_name: "Mon" },
      { slug: "angus",  display_name: "Angus" },
    ],
  },
];

export const ASSIGNABLE_MEMBERS: RosterMember[] = ROSTER_GROUPS.flatMap(g => g.members);

export const LIVE_DATA_TEAM = new Set(ROSTER_GROUPS[0].members.map(m => m.slug));
