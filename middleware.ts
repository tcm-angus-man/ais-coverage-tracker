import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: {
    signIn: "/signin",
  },
});

// Run on every route except NextAuth internals, cron routes, static files, and the signin page itself
export const config = {
  matcher: [
    "/((?!api/auth|api/cron|_next/static|_next/image|favicon.ico|signin).*)",
  ],
};
