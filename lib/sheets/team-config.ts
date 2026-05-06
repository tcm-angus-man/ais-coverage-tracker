import "server-only";
import type { Role } from "@/lib/types/session";

export type TeamMember = {
  slug: string;
  display_name: string;
  db_user_id: string | null; // matches updated_by column (stored as text)
  role: Role;
  active: boolean;
};

// Maps db updated_by value → display name. data-platform is the system default
// and is excluded from the reviewer leaderboard.
export const TEAM_MEMBERS: TeamMember[] = [
  { slug: "angus",    display_name: "Angus",    db_user_id: "8",  role: "assigner", active: true },
  { slug: "mon",      display_name: "Mon",      db_user_id: "10", role: "assigner", active: true },
  { slug: "bea",      display_name: "Bea",      db_user_id: "11", role: "cleaner",  active: true },
  { slug: "ronnel",   display_name: "Ronnel",   db_user_id: "12", role: "cleaner",  active: true },
  { slug: "kaye",     display_name: "Kaye",     db_user_id: "13", role: "cleaner",  active: true },
  { slug: "coleen",   display_name: "Coleen",   db_user_id: "16", role: "cleaner",  active: true },
  { slug: "kim",      display_name: "Kim",      db_user_id: "17", role: "cleaner",  active: true },
  { slug: "nick",     display_name: "Nick",     db_user_id: "19", role: "cleaner",  active: true },
  { slug: "nicole",   display_name: "Nicole",   db_user_id: "21", role: "cleaner",  active: true },
  { slug: "jayziel",  display_name: "Jayziel",  db_user_id: "22", role: "cleaner",  active: true },
  { slug: "ai-ai",    display_name: "Ai-ai",    db_user_id: "23", role: "cleaner",  active: true },
  { slug: "rome",     display_name: "Rome",     db_user_id: "26", role: "cleaner",  active: true },
  { slug: "rich",     display_name: "Rich",     db_user_id: "28", role: "assigner", active: true },
  { slug: "dave",     display_name: "Dave",     db_user_id: "29", role: "cleaner",  active: true },
  { slug: "jen",      display_name: "Jen",      db_user_id: "31", role: "cleaner",  active: true },
  { slug: "jovi",     display_name: "Jovi",     db_user_id: "37", role: "cleaner",  active: true },
];

// Lookup by db_user_id string — used in progress API
export function memberByUserId(userId: string): TeamMember | undefined {
  return TEAM_MEMBERS.find(m => m.db_user_id === userId);
}

const DOMAIN = "thecruisemaps.com";

export async function lookupTeamMember(email: string): Promise<TeamMember | null> {
  const e = email.toLowerCase();
  return TEAM_MEMBERS.find(m => m.active && `${m.slug}@${DOMAIN}` === e) ?? null;
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  return TEAM_MEMBERS.filter(m => m.active);
}
