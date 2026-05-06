import "server-only";
import type { Role } from "@/lib/types/session";

export type TeamMember = {
  slug: string;
  display_name: string;
  google_email: string;
  db_user_id: string | null; // matches updated_by column (stored as text)
  role: Role;
  active: boolean;
};

// Maps db updated_by value → display name. data-platform is the system default
// and is excluded from the reviewer leaderboard.
export const TEAM_MEMBERS: TeamMember[] = [
  { slug: "angus",    display_name: "Angus",    google_email: "angus@thecruisemaps.com",    db_user_id: "8",             role: "assigner", active: true },
  { slug: "mon",      display_name: "Mon",      google_email: "mon@thecruisemaps.com",      db_user_id: "10",            role: "assigner", active: true },
  { slug: "bea",      display_name: "Bea",      google_email: "bea@thecruisemaps.com",      db_user_id: "11",            role: "cleaner",  active: true },
  { slug: "ronnel",   display_name: "Ronnel",   google_email: "ronnel@thecruisemaps.com",   db_user_id: "12",            role: "cleaner",  active: true },
  { slug: "kaye",     display_name: "Kaye",     google_email: "kaye@thecruisemaps.com",     db_user_id: "13",            role: "cleaner",  active: true },
  { slug: "coleen",   display_name: "Coleen",   google_email: "coleen@thecruisemaps.com",   db_user_id: "16",            role: "cleaner",  active: true },
  { slug: "kim",      display_name: "Kim",      google_email: "kim@thecruisemaps.com",      db_user_id: "17",            role: "cleaner",  active: true },
  { slug: "nick",     display_name: "Nick",     google_email: "nick@thecruisemaps.com",     db_user_id: "19",            role: "cleaner",  active: true },
  { slug: "nicole",   display_name: "Nicole",   google_email: "nicole@thecruisemaps.com",   db_user_id: "21",            role: "cleaner",  active: true },
  { slug: "jayziel",  display_name: "Jayziel",  google_email: "jayziel@thecruisemaps.com",  db_user_id: "22",            role: "cleaner",  active: true },
  { slug: "ai-ai",    display_name: "Ai-ai",    google_email: "ai-ai@thecruisemaps.com",    db_user_id: "23",            role: "cleaner",  active: true },
  { slug: "rome",     display_name: "Rome",     google_email: "rome@thecruisemaps.com",     db_user_id: "26",            role: "cleaner",  active: true },
  { slug: "rich",     display_name: "Rich",     google_email: "rich@thecruisemaps.com",     db_user_id: "28",            role: "assigner", active: true },
  { slug: "dave",     display_name: "Dave",     google_email: "dave@thecruisemaps.com",     db_user_id: "29",            role: "cleaner",  active: true },
  { slug: "jen",      display_name: "Jen",      google_email: "jen@thecruisemaps.com",      db_user_id: "31",            role: "cleaner",  active: true },
  { slug: "jovi",     display_name: "Jovi",     google_email: "jovi@thecruisemaps.com",     db_user_id: "37",            role: "cleaner",  active: true },
];

// Lookup by db_user_id string — used in progress API
export function memberByUserId(userId: string): TeamMember | undefined {
  return TEAM_MEMBERS.find(m => m.db_user_id === userId);
}

export async function lookupTeamMember(email: string): Promise<TeamMember | null> {
  const e = email.toLowerCase();
  return TEAM_MEMBERS.find(m => m.active && m.google_email.toLowerCase() === e) ?? null;
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  return TEAM_MEMBERS.filter(m => m.active);
}
