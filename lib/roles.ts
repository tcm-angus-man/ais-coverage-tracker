import "server-only";
import type { Session } from "next-auth";
import type { Role } from "@/lib/types/session";
import { TEAM_MEMBERS } from "@/lib/sheets/team-config";

export class RoleError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

export function isAssigner(session: Session | null): boolean {
  return session?.user?.role === "assigner";
}

// Assignment writes (POST and PATCH). Any active team member may create or
// change any assignment. Checked per request against TEAM_MEMBERS because
// sessions are JWTs: a departed member's token keeps its old role until it
// expires. Does NOT imply admin-route access — that stays isAssigner.
export function canAssign(session: Session | null): boolean {
  const slug = session?.user?.slug;
  const role = session?.user?.role;
  if (!slug || (role !== "assigner" && role !== "cleaner")) return false;
  return TEAM_MEMBERS.some(m => m.slug === slug && m.active);
}

export function isCleaner(session: Session | null): boolean {
  return session?.user?.role === "cleaner";
}

export function requireSession(session: Session | null): Session {
  if (!session?.user) throw new RoleError("Not signed in", 401);
  return session;
}

export function requireRole(
  session: Session | null,
  ...roles: Role[]
): Session {
  const s = requireSession(session);
  const role = s.user.role;
  if (!roles.includes(role)) {
    throw new RoleError(`Requires one of: ${roles.join(", ")}`);
  }
  return s;
}
