"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import CoverageLoader from "./CoverageLoader";

export type ShellMode = "voyage" | "silver" | "combined";

const MODE_FOR_PATH: Record<string, ShellMode> = {
  "/coverage":    "voyage",
  "/cleanliness": "silver",
  "/merged":      "combined",
};

const TAB_META: Record<ShellMode, { eyebrow: string; title: string; titleAccent: string; subtitle: string; accentVar: string; gradientColor: string }> = {
  voyage: {
    eyebrow:       "AIS Coverage · Voyages",
    title:         "Voyage",
    titleAccent:   "Coverage",
    subtitle:      "Each cell = one ship-day.",
    accentVar:     "var(--accent)",
    gradientColor: "rgba(232,193,112,0.025)",
  },
  silver: {
    eyebrow:       "AIS Coverage · Silver",
    title:         "Silver",
    titleAccent:   "Cleanliness",
    subtitle:      "Each cell = one cleaned ship-day. From 2025-07-01.",
    accentVar:     "var(--clean-edge)",
    gradientColor: "rgba(78,163,116,0.025)",
  },
  combined: {
    eyebrow:       "AIS Coverage · Combined",
    title:         "Merged",
    titleAccent:   "View",
    subtitle:      "Top-right triangle = voyage · bottom-left = silver.",
    accentVar:     "var(--accent)",
    gradientColor: "rgba(232,193,112,0.025)",
  },
};

const TABS: { mode: ShellMode; label: string; href: string }[] = [
  { mode: "voyage",   label: "Coverage",    href: "/coverage" },
  { mode: "silver",   label: "Cleanliness", href: "/cleanliness" },
  { mode: "combined", label: "Merged",      href: "/merged" },
];

export default function CoverageShell({ initialMode }: { initialMode: ShellMode }) {
  const pathname = usePathname() ?? "";
  // Derive mode from URL so navigating via the nav bar also switches the view
  const modeFromPath = MODE_FOR_PATH[pathname] ?? initialMode;

  // Use router.push to change path without reloading — payload stays in memory
  // because CoverageLoader is never unmounted (it lives here, not in each page)
  const [mode, setMode] = useState<ShellMode>(modeFromPath);

  // Sync if user navigates via back/forward or the top nav
  useEffect(() => {
    const m = MODE_FOR_PATH[pathname];
    if (m && m !== mode) setMode(m);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = TAB_META[mode];

  // Push URL when user clicks a tab, without a full page navigation
  const switchMode = (m: ShellMode, href: string) => {
    setMode(m);
    window.history.pushState(null, "", href);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Page header — tabs live here */}
      <div style={{
        padding: "14px 36px 12px",
        borderBottom: "1px solid var(--line)",
        background: `linear-gradient(180deg, ${meta.gradientColor}, transparent 80%)`,
        flexShrink: 0,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 24,
      }}>
        <div>
          <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: meta.accentVar, marginBottom: 5, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-block", width: 16, height: 1, background: meta.accentVar }} />
            {meta.eyebrow}
          </div>
          <h1 style={{ fontFamily: "Fraunces, serif", fontWeight: 400, fontSize: 26, margin: "0 0 2px", letterSpacing: "-0.02em", color: "var(--ink)" }}>
            {meta.title}{" "}
            <em style={{ fontStyle: "italic", fontWeight: 300, color: meta.accentVar }}>{meta.titleAccent}</em>
          </h1>
          <p style={{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontWeight: 300, fontSize: 12, color: "var(--ink-dim)", margin: 0 }}>
            {meta.subtitle}
          </p>
        </div>

        {/* Inline tab switcher — same data, zero reload */}
        <div style={{ display: "flex", gap: 2, paddingBottom: 3, flexShrink: 0 }}>
          {TABS.map(t => {
            const active = t.mode === mode;
            return (
              <button
                key={t.mode}
                onClick={() => switchMode(t.mode, t.href)}
                style={{
                  padding: "4px 13px",
                  fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em",
                  cursor: "pointer", borderRadius: 2,
                  border: `1px solid ${active ? meta.accentVar : "var(--line)"}`,
                  background: active ? meta.accentVar : "transparent",
                  color: active ? "#1a1207" : "var(--ink-faint)",
                  fontWeight: active ? 600 : 400,
                  fontFamily: "inherit",
                  transition: "background 0.1s, color 0.1s, border-color 0.1s",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Single CoverageLoader — never unmounts, mode prop switches render */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <CoverageLoader modeOverride={mode} />
      </div>
    </div>
  );
}
