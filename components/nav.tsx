"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";

// These three tabs share one CoverageShell instance that must not be unmounted
// between switches — the blob payload (160 MB decompressed) lives in its state.
// We intercept clicks and use pushState so Next.js never navigates away from
// the current page component tree.
const SHELL_HREFS = new Set(["/coverage", "/cleanliness", "/merged"]);

const TABS = [
  { href: "/coverage",    label: "Coverage",    n: "01" },
  { href: "/cleanliness", label: "Cleanliness", n: "02" },
  { href: "/merged",      label: "Merged",      n: "03" },
  { href: "/queue",       label: "Queue",        n: "04" },
  { href: "/progress",   label: "Progress",     n: "05" },
];

export default function Nav() {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();

  return (
    <header style={{
      display: "flex",
      alignItems: "stretch",
      borderBottom: "1px solid var(--line)",
      background: "var(--bg-2)",
      padding: "0 36px",
    }}>
      {/* Wordmark */}
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", marginRight: 36, paddingRight: 36, borderRight: "1px solid var(--line)" }}>
        <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--accent)", lineHeight: 1 }}>
          AIS
        </div>
        <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 18, color: "var(--ink)", lineHeight: 1.2, marginTop: 3, letterSpacing: "-0.01em" }}>
          Progress Tracker
        </div>
      </div>

      {/* Tabs */}
      <nav style={{ display: "flex", alignItems: "stretch", flex: 1 }}>
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
          const isShellTab = SHELL_HREFS.has(tab.href);
          // Shell tabs (Coverage/Cleanliness/Merged): pushState keeps the component
          // tree alive so CoverageLoader never unmounts and never re-fetches the blob.
          // Only intercept (suppress full navigation) when already on a shell page —
          // if CoverageShell is mounted, pushState keeps it alive. If not, let
          // Next.js navigate normally so it mounts fresh.
          const currentlyOnShell = SHELL_HREFS.has(pathname);
          const handleClick = isShellTab && currentlyOnShell
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                if (!active) {
                  window.history.pushState(null, "", tab.href);
                  window.dispatchEvent(new CustomEvent("shellnavigate", { detail: tab.href }));
                }
              }
            : undefined;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              onClick={handleClick}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "0 18px",
                borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--ink)" : "var(--ink-faint)",
                textDecoration: "none",
                transition: "color 0.15s, border-color 0.15s",
                gap: 2,
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = "var(--ink-dim)"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = "var(--ink-faint)"; }}
            >
              <span style={{ fontSize: 9, letterSpacing: "0.18em", color: "var(--ink-faint)", lineHeight: 1 }}>
                {tab.n}
              </span>
              <span style={{
                fontSize: 11.5,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: active ? 600 : 400,
                lineHeight: 1,
              }}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* User */}
      {session?.user && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 24, borderLeft: "1px solid var(--line)" }}>
          <div style={{
            width: 26, height: 26, borderRadius: "50%",
            background: "var(--panel)", border: "1px solid var(--line-2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10, color: "var(--ink-dim)", fontWeight: 500, userSelect: "none",
          }}>
            {(session.user.display_name ?? session.user.email ?? "?")[0].toUpperCase()}
          </div>
          <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
            {session.user.display_name ?? session.user.email}
          </span>
          <button
            onClick={() => signOut()}
            style={{ fontSize: 11, color: "var(--ink-faint)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--ink-dim)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--ink-faint)")}
          >
            sign out
          </button>
        </div>
      )}
    </header>
  );
}
