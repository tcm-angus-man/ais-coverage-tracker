"use client";

import { useSession } from "next-auth/react";
import type { Role } from "@/lib/types/session";

// UI-only gate. Server routes must enforce permissions independently
// via lib/roles.ts requireRole.
export default function RoleGate({
  allow,
  children,
  fallback = null,
}: {
  allow: Role[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  if (status !== "authenticated") return fallback;
  return allow.includes(session.user.role) ? <>{children}</> : <>{fallback}</>;
}
