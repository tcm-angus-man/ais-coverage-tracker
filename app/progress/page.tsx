"use client";

import { useEffect, useRef, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const C_BG        = "#0b1014";
const C_BG2       = "#0f161c";
const C_PANEL     = "#131c24";
const C_LINE      = "#162028";
const C_INK       = "#e7eef3";
const C_INK_DIM   = "#93a4b2";
const C_INK_FAINT = "#5a6d7c";
const C_ACCENT    = "#e8c170";
const C_CLEAN     = "#4ea374";

const REVIEWER_COLORS = ["#4ea374", "#e8c170", "#5a9fd4", "#b47abf", "#d35454", "#6dbf91", "#b8712a"];

const REFRESH_MS = 60_000;

type Reviewer = {
  user_id:      string;
  display_name: string;
  slug:         string;
  days_cleaned: number;
  last_active:  string;
  daily:        { date: string; count: number }[];
  color:        string;
};

type RecentRow = {
  updated_by:   string;
  display_name: string;
  ship_name:    string | null;
  mmsi:         number;
  date:         string;
  updated_at:   string;
};

type ApiResponse = {
  ok:        boolean;
  error?:    string;
  reviewers: Omit<Reviewer, "color">[];
  totals:    { total_days: number; clean_days: number };
  recent:    RecentRow[];
};

export default function ProgressPage() {
  const [data, setData]       = useState<ApiResponse | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimer() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }

  async function load() {
    try {
      const r = await fetch("/api/progress", { credentials: "include" });
      const d: ApiResponse = await r.json();
      if (!d.ok) throw new Error(d.error ?? "API error");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function scheduleNext() {
    clearTimer();
    timerRef.current = setTimeout(() => {
      // Only refresh when the tab is visible
      if (document.visibilityState === "visible") {
        load().then(scheduleNext);
      } else {
        // Retry once visible
        const onVisible = () => {
          if (document.visibilityState === "visible") {
            document.removeEventListener("visibilitychange", onVisible);
            load().then(scheduleNext);
          }
        };
        document.addEventListener("visibilitychange", onVisible);
      }
    }, REFRESH_MS);
  }

  useEffect(() => {
    load().then(scheduleNext);
    return clearTimer;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <LoadingState />;
  if (error || !data?.ok) return <ErrorState msg={error ?? data?.error ?? "API error"} onRetry={() => { setLoading(true); setError(null); load().then(scheduleNext); }} />;

  const reviewers: Reviewer[] = data.reviewers.map((r, i) => ({
    ...r,
    color: REVIEWER_COLORS[i % REVIEWER_COLORS.length],
  }));

  const cleanPct = data.totals.total_days === 0 ? 0 :
    Math.round((data.totals.clean_days / data.totals.total_days) * 1000) / 10;

  const allDates = Array.from(new Set(reviewers.flatMap(r => r.daily.map(d => d.date)))).sort();
  const areaData = allDates.map(date => {
    const point: Record<string, string | number> = { date: date.slice(5) };
    for (const r of reviewers) {
      const day = r.daily.find(d => d.date === date);
      point[r.slug] = day?.count ?? 0;
    }
    return point;
  });

  const last30 = allDates.slice(-30);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, background: C_BG, color: C_INK, overflow: "auto" }}>

      {/* Page header */}
      <div style={{ padding: "20px 36px 16px", borderBottom: `1px solid ${C_LINE}`, background: "linear-gradient(180deg, rgba(232,193,112,0.025), transparent 80%)", flexShrink: 0 }}>
        <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: C_ACCENT, marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "inline-block", width: 20, height: 1, background: C_ACCENT }} />
          AIS Coverage · Team
        </div>
        <h1 style={{ fontFamily: "Fraunces, serif", fontWeight: 400, fontSize: 32, margin: "0 0 4px", letterSpacing: "-0.02em", color: C_INK }}>
          Cleaning <em style={{ fontStyle: "italic", fontWeight: 300, color: C_ACCENT }}>Progress</em>
        </h1>
        <p style={{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontWeight: 300, fontSize: 14, color: C_INK_DIM, margin: 0 }}>
          Who has reviewed silver data, and when.
        </p>
      </div>

      {/* KPI bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 36, padding: "10px 36px", background: C_BG2, borderBottom: `1px solid ${C_LINE}`, flexShrink: 0 }}>
        <KpiStat value={data.totals.clean_days.toLocaleString()} label="Days cleaned" color={C_CLEAN} />
        <KpiStat value={data.totals.total_days.toLocaleString()} label="Total ship-days" />
        <KpiStat value={`${cleanPct}%`} label="Clean rate" color={cleanPct > 50 ? C_CLEAN : C_ACCENT} />
        <KpiStat value={String(reviewers.length)} label="Active reviewers" />
        <div style={{ marginLeft: "auto", fontSize: 9.5, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums" }}>
          Refreshes every 60 s
        </div>
      </div>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* Left: leaderboard + recent */}
        <div style={{ width: 320, borderRight: `1px solid ${C_LINE}`, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>

          <div style={{ padding: "16px 20px 0" }}>
            <SectionLabel>Leaderboard</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {reviewers.map((r, i) => (
                <div key={r.user_id} style={{ background: C_PANEL, border: `1px solid ${C_LINE}`, borderRadius: 4, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
                  <div style={{ position: "absolute", top: 8, right: 12, fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 24, color: C_LINE, lineHeight: 1 }}>{i + 1}</div>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: r.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: "#0b1014", flexShrink: 0 }}>
                    {r.display_name.slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: C_INK }}>{r.display_name}</div>
                    <div style={{ fontSize: 9.5, color: C_INK_FAINT, marginTop: 2 }}>Last active {r.last_active}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 22, color: r.color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{r.days_cleaned.toLocaleString()}</div>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: C_INK_FAINT, marginTop: 2 }}>days</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ padding: "20px 20px 16px", marginTop: 8 }}>
            <SectionLabel>Recent reviews</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 10 }}>
              {data.recent.slice(0, 20).map((row, i) => {
                const rev = reviewers.find(r => r.user_id === row.updated_by);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C_LINE}` }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: rev?.color ?? C_INK_FAINT, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: C_INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.ship_name ?? `MMSI ${row.mmsi}`}
                      </div>
                      <div style={{ fontSize: 9.5, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", marginTop: 1 }}>
                        {row.date} · {row.display_name}
                      </div>
                    </div>
                    <div style={{ fontSize: 9.5, color: C_INK_FAINT, flexShrink: 0 }}>
                      {row.updated_at.slice(0, 10)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: charts */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", padding: "20px 36px", gap: 32 }}>

          {/* 30-day stacked bar */}
          <div>
            <SectionLabel>30-day activity</SectionLabel>
            <div style={{ display: "flex", alignItems: "flex-end", height: 100, gap: 3, marginTop: 14 }}>
              {last30.map((date, i) => {
                const total = reviewers.reduce((s, r) => s + (r.daily.find(d => d.date === date)?.count ?? 0), 0);
                return (
                  <div key={date} style={{ display: "flex", flexDirection: "column-reverse", flex: 1 }}>
                    {total === 0 ? (
                      <div style={{ background: C_LINE, height: 3, borderRadius: "2px 2px 0 0" }} />
                    ) : (
                      reviewers.map(r => {
                        const count = r.daily.find(d => d.date === date)?.count ?? 0;
                        const h = Math.round((count / total) * 100);
                        return h > 0 ? (
                          <div key={r.slug} style={{ background: r.color, height: `${h}%`, minHeight: 2 }} />
                        ) : null;
                      })
                    )}
                    <div style={{ fontSize: 7.5, color: C_INK_FAINT, textAlign: "center", marginTop: 3, opacity: i % 5 === 0 ? 1 : 0 }}>
                      {date.slice(5)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
              {reviewers.map(r => (
                <div key={r.slug} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                  <span style={{ fontSize: 10, color: C_INK_DIM }}>{r.display_name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Area chart */}
          {areaData.length > 0 && (
            <div style={{ flex: 1, minHeight: 200 }}>
              <SectionLabel>Daily reviews (last 60 days)</SectionLabel>
              <div style={{ marginTop: 14, height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={areaData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                    <defs>
                      {reviewers.map(r => (
                        <linearGradient key={r.slug} id={`grad-${r.slug}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={r.color} stopOpacity={0.4} />
                          <stop offset="95%" stopColor={r.color} stopOpacity={0} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid vertical={false} stroke={C_LINE} />
                    <XAxis dataKey="date" tick={{ fill: C_INK_FAINT, fontSize: 9.5, fontFamily: "JetBrains Mono, monospace" }} axisLine={false} tickLine={false} interval={6} />
                    <YAxis tick={{ fill: C_INK_FAINT, fontSize: 9.5, fontFamily: "JetBrains Mono, monospace" }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: C_PANEL, border: `1px solid ${C_LINE}`, borderRadius: 3, fontSize: 11, color: C_INK, fontFamily: "JetBrains Mono, monospace" }}
                      labelStyle={{ color: C_INK_DIM, marginBottom: 4 }}
                    />
                    {reviewers.map(r => (
                      <Area key={r.slug} type="monotone" dataKey={r.slug} stroke={r.color} strokeWidth={1.5} fill={`url(#grad-${r.slug})`} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {reviewers.length === 0 && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C_INK_FAINT, fontSize: 11 }}>
              No review activity yet — updated_by is not set on any clean silver rows.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiStat({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 26, letterSpacing: "-0.02em", color: color ?? C_INK, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT }}>{children}</div>;
}

function LoadingState() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, background: C_BG, gap: 12 }}>
      <div style={{ fontSize: 11, color: C_INK_DIM }}>Loading progress data…</div>
      <div style={{ width: 120, height: 2, background: C_LINE, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", background: C_ACCENT, width: "60%" }} />
      </div>
    </div>
  );
}

function ErrorState({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, background: C_BG, gap: 16 }}>
      <div style={{ fontSize: 11, color: "#d35454" }}>Failed to load progress: {msg}</div>
      <button
        onClick={onRetry}
        style={{ padding: "6px 16px", background: C_ACCENT, color: "#1a1207", border: "none", borderRadius: 3, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
      >
        Retry
      </button>
    </div>
  );
}
