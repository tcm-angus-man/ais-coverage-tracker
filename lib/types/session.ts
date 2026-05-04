import type { DefaultSession } from "next-auth";

export type Role = "assigner" | "cleaner" | "viewer";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      slug: string | null;
      role: Role;
      db_user_id: number | null;
      display_name: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    slug?: string | null;
    role?: Role;
    db_user_id?: number | null;
    display_name?: string | null;
  }
}
