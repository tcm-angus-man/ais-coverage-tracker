import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { lookupTeamMember } from "@/lib/sheets/team-config";

const ALLOWED_DOMAIN = "thecruisemaps.com";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      if (!email) return false;
      return email.endsWith(`@${ALLOWED_DOMAIN}`);
    },
    async jwt({ token, profile }) {
      const email = (profile?.email ?? token.email)?.toLowerCase();
      if (email) {
        const member = await lookupTeamMember(email);
        if (member) {
          token.slug = member.slug;
          token.role = member.role;
          token.db_user_id = member.db_user_id;
          token.display_name = member.display_name;
        } else {
          token.slug = null;
          token.role = "viewer";
          token.db_user_id = null;
          token.display_name = null;
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        slug: (token.slug as string | null) ?? null,
        role:
          (token.role as "assigner" | "cleaner" | "viewer" | undefined) ??
          "viewer",
        db_user_id: (token.db_user_id as number | null) ?? null,
        display_name: (token.display_name as string | null) ?? null,
      };
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
  session: { strategy: "jwt" },
};
