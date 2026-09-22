// Client-safe team roster. Lives here rather than in lib/sheets/team-config.ts
// because that module is "server-only"; shared by the grid's assign modal and
// the /gaps worklist so there is one roster, not two.

export const LIVE_DATA_TEAM = new Set(["nick", "ai-ai", "kim"]);

// All cleaners — live-data team first, then rest.
export const ASSIGNABLE_MEMBERS = [
  { slug: "nick",    display_name: "Nick" },
  { slug: "ai-ai",  display_name: "Ai-ai" },
  { slug: "kim",    display_name: "Kim" },
  { slug: "bea",    display_name: "Bea" },
  { slug: "ronnel", display_name: "Ronnel" },
  { slug: "kaye",   display_name: "Kaye" },
  { slug: "coleen", display_name: "Coleen" },
  { slug: "nicole", display_name: "Nicole" },
  { slug: "jayziel",display_name: "Jayziel" },
  { slug: "rome",   display_name: "Rome" },
  { slug: "dave",   display_name: "Dave" },
  { slug: "jen",    display_name: "Jen" },
  { slug: "jovi",   display_name: "Jovi" },
];
