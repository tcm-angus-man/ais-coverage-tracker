import "server-only";
import type { Session } from "next-auth";
import type { Role } from "@/lib/types/session";

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
