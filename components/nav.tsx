"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signIn, signOut, useSession } from "next-auth/react";

const LINKS: { href: string; label: string; roles?: ("assigner" | "cleaner" | "viewer")[] }[] = [
  { href: "/coverage", label: "coverage" },
  { href: "/queue", label: "queue" },
  { href: "/me", label: "me" },
  { href: "/team", label: "team" },
];

export default function Nav() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? "viewer";

  return (
    <header className="h-11 px-3 border-b border-neutral-800 bg-neutral-900 flex items-center gap-4 text-sm">
      <span className="font-semibold tracking-tight">ais coverage tracker</span>
      <nav className="flex gap-1">
        {LINKS.filter((l) => !l.roles || l.roles.includes(role)).map((l) => {
          const active = pathname === l.href || pathname.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`px-2 py-1 rounded text-xs ${
                active
                  ? "bg-emerald-700 text-white"
                  : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
        {status === "loading" ? null : session?.user ? (
          <>
            <span className="tabular-nums">
              {session.user.display_name ?? session.user.email} · {role}
            </span>
            <button
              onClick={() => signOut()}
              className="px-2 py-1 rounded hover:bg-neutral-800"
            >
              sign out
            </button>
          </>
        ) : (
          <button
            onClick={() => signIn("google")}
            className="px-2 py-1 rounded bg-emerald-700 text-white"
          >
            sign in
          </button>
        )}
      </div>
    </header>
  );
}
