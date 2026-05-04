import "server-only";
import type { Role } from "@/lib/types/session";

// Phase 0 stub — hard-coded team. Phase 2 replaces with a cached read of
// the `team_config` tab in the Google Sheet (via lib/sheets/client.ts and
// unstable_cache with a short TTL).
export type TeamMember = {
  slug: string;
  display_name: string;
  google_email: string;
  db_user_id: number | null;
  role: Role;
  active: boolean;
};

const STUB: TeamMember[] = [
  {
    slug: "angus",
    display_name: "Angus",
    google_email: "angus@thecruisemaps.com",
    db_user_id: null,
    role: "assigner",
    active: true,
  },
  {
    slug: "mon",
    display_name: "Mon",
    google_email: "mon@thecruisemaps.com",
    db_user_id: null,
    role: "assigner",
    active: true,
  },
];

export async function lookupTeamMember(
  email: string,
): Promise<TeamMember | null> {
  const e = email.toLowerCase();
  return STUB.find((m) => m.active && m.google_email.toLowerCase() === e) ?? null;
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  return STUB.filter((m) => m.active);
}
