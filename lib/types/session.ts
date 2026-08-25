import type { DefaultSession } from "next-auth";

export type Role = "assigner" | "cleaner" | "viewer";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      slug: string | null;
      role: Role;
      db_user_id: string | null;
      display_name: string | null;
      // Cleaners who may also create assignments. Narrower than "assigner":
      // grants assignment creation only, not admin routes.
      can_assign: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    slug?: string | null;
    role?: Role;
    db_user_id?: string | null;
    display_name?: string | null;
    can_assign?: boolean;
  }
}
