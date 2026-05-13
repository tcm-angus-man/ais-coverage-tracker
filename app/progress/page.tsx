"use client";

import { useEffect, useRef, useState } from "react";

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
  daily30:      { date: string; count: number }[];
  color:        string;
};

type TodayRow = {
  user_id:         string;
  display_name:    string;
  count:           number;
  last_updated_at: string;
};

type RecentRow = {
  updated_by:   string;
  display_name: string;
  ship_name:    string | null;
  mmsi:         number;
  date:         string;
  updated_at:   string;
};

type TodayHourly = {
  user_id:      string;
  display_name: string;
  slug:         string;
  hours:        number[]; // length 24, value at index h = count for that hour
};

type ApiResponse = {
  ok:            boolean;
  error?:        string;
  reviewers:     Omit<Reviewer, "color">[];
  totals:        { total_days: number; clean_days: number };
  recent:        RecentRow[];
  today:         TodayRow[];
  today_hourly:  TodayHourly[];
};

// ---------- bar chart with hover ----------
type BarDatum = { date: string; total: number; breakdown: { slug: string; display_name: string; count: number; color: string }[] };

function ActivityBarChart({ data, reviewers, maxBars }: { data: BarDatum[]; reviewers: Reviewer[]; maxBars: number }) {
  const [hovered, setHovered] = useState<{ idx: number; x: number; y: number } | null>(null);
  const sliced = data.slice(-maxBars);
  const maxVal = Math.max(...sliced.map(d => d.total), 1);

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-end", height: 120, gap: 3 }}>
        {sliced.map((d, i) => (
          <div
            key={d.date}
            style={{ display: "flex", flexDirection: "column-reverse", flex: 1, cursor: "pointer", position: "relative" }}
            onMouseEnter={e => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setHovered({ idx: i, x: rect.left + rect.width / 2, y: rect.top });
            }}
            onMouseLeave={() => setHovered(null)}
          >
            {d.total === 0 ? (
              <div style={{ background: C_LINE, height: 3, borderRadius: "2px 2px 0 0" }} />
            ) : (
              d.breakdown.map(b => {
                const h = Math.round((b.count / maxVal) * 120);
                return h > 0 ? (
                  <div
                    key={b.slug}
                    style={{ background: b.color, height: h, minHeight: 2, transition: "opacity 0.1s" }}
                  />
                ) : null;
              })
            )}
            <div style={{
              fontSize: 7.5, color: C_INK_FAINT, textAlign: "center", marginTop: 4,
              opacity: i % Math.ceil(maxBars / 7) === 0 ? 1 : 0,
              whiteSpace: "nowrap",
            }}>
              {d.date.slice(5)}
            </div>
          </div>
        ))}
      </div>

      {/* Hover tooltip */}
      {hovered !== null && sliced[hovered.idx] && (
        <div style={{
          position: "fixed",
          left: hovered.x,
          top: hovered.y - 8,
          transform: "translate(-50%, -100%)",
          zIndex: 60,
          background: C_PANEL,
          border: `1px solid ${C_LINE}`,
          borderRadius: 4,
          padding: "8px 12px",
          fontSize: 11,
          color: C_INK,
          pointerEvents: "none",
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          minWidth: 140,
        }}>
          <div style={{ fontVariantNumeric: "tabular-nums", color: C_INK_DIM, fontSize: 10, marginBottom: 5 }}>
            {sliced[hovered.idx].date}
          </div>
          {sliced[hovered.idx].breakdown.filter(b => b.count > 0).map(b => (
            <div key={b.slug} style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 2 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: b.color, display: "inline-block", flexShrink: 0 }} />
                <span style={{ color: C_INK_DIM }}>{b.display_name}</span>
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: b.color }}>{b.count}</span>
            </div>
          ))}
          {sliced[hovered.idx].total === 0 && <div style={{ color: C_INK_FAINT }}>No activity</div>}
          <div style={{ borderTop: `1px solid ${C_LINE}`, marginTop: 5, paddingTop: 5, display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: C_INK_FAINT }}>Total</span>
            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{sliced[hovered.idx].total}</span>
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
        {reviewers.map(r => (
          <div key={r.slug} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
            <span style={{ fontSize: 10, color: C_INK_DIM }}>{r.display_name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 24-hour SVG line chart. One line per teammate, X = hour, Y = updates that hour.
function TodayHourlyChart({ hourly, reviewers, total }: { hourly: TodayHourly[]; reviewers: Reviewer[]; total: number }) {
  const [hovered, setHovered] = useState<{ hour: number; x: number; y: number } | null>(null);

  if (hourly.length === 0 || total === 0) {
    return (
      <div style={{ padding: "20px 16px", textAlign: "center", fontSize: 11, color: C_INK_FAINT, border: `1px dashed ${C_LINE}`, borderRadius: 4 }}>
        No cleaning activity yet today.
      </div>
    );
  }

  const colorByUserId = new Map(reviewers.map(r => [r.user_id, r.color] as const));
  const fallback = C_ACCENT;

  const W = 800, H = 140, PAD_L = 28, PAD_B = 20, PAD_T = 8, PAD_R = 8;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const hourTotals = new Array(24).fill(0);
  for (const r of hourly) for (let i = 0; i < 24; i++) hourTotals[i] += r.hours[i];
  const maxVal = Math.max(...hourly.flatMap(r => r.hours), 1);

  const xOf = (h: number) => PAD_L + (h / 23) * chartW;
  const yOf = (v: number) => PAD_T + chartH - (v / maxVal) * chartH;

  const toPath = (hours: number[]) =>
    hours.map((v, h) => `${h === 0 ? "M" : "L"}${xOf(h).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
        onMouseMove={e => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const relX = (e.clientX - rect.left) / rect.width * W;
          const h = Math.round(((relX - PAD_L) / chartW) * 23);
          if (h >= 0 && h <= 23) setHovered({ hour: h, x: e.clientX, y: e.clientY });
          else setHovered(null);
        }}
        onMouseLeave={() => setHovered(null)}
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const y = PAD_T + chartH * (1 - f);
          return (
            <g key={f}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={C_LINE} strokeWidth={1} />
              {f > 0 && <text x={PAD_L - 4} y={y + 3.5} fontSize={7} fill={C_INK_FAINT} textAnchor="end">{Math.round(maxVal * f)}</text>}
            </g>
          );
        })}

        {/* Lines per reviewer */}
        {hourly.map(r => {
          const color = colorByUserId.get(r.user_id) ?? fallback;
          const active = hovered && r.hours[hovered.hour] > 0;
          return (
            <path
              key={r.user_id}
              d={toPath(r.hours)}
              fill="none"
              stroke={color}
              strokeWidth={active ? 2.5 : 1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={hovered ? (active ? 1 : 0.25) : 0.85}
              style={{ transition: "opacity 0.1s, stroke-width 0.1s" }}
            />
          );
        })}

        {/* Hover vertical line */}
        {hovered && (
          <line
            x1={xOf(hovered.hour)} y1={PAD_T}
            x2={xOf(hovered.hour)} y2={PAD_T + chartH}
            stroke={C_INK_FAINT} strokeWidth={1} strokeDasharray="3 3"
          />
        )}

        {/* Dots at hovered hour */}
        {hovered && hourly.filter(r => r.hours[hovered.hour] > 0).map(r => {
          const color = colorByUserId.get(r.user_id) ?? fallback;
          return (
            <circle
              key={r.user_id}
              cx={xOf(hovered.hour)} cy={yOf(r.hours[hovered.hour])}
              r={3} fill={color} stroke={C_BG} strokeWidth={1.5}
            />
          );
        })}

        {/* X-axis labels every 3h */}
        {Array.from({ length: 24 }, (_, h) => h % 3 === 0 && (
          <text key={h} x={xOf(h)} y={H - 4} fontSize={8} fill={C_INK_FAINT} textAnchor="middle">
            {String(h).padStart(2, "0")}
          </text>
        ))}
      </svg>

      {/* Hover tooltip */}
      {hovered && (
        <div style={{
          position: "fixed", left: hovered.x, top: hovered.y - 8,
          transform: "translate(-50%, -100%)", zIndex: 60,
          background: C_PANEL, border: `1px solid ${C_LINE}`,
          borderRadius: 4, padding: "8px 12px", fontSize: 11, color: C_INK,
          pointerEvents: "none", boxShadow: "0 4px 16px rgba(0,0,0,0.5)", minWidth: 150,
        }}>
          <div style={{ fontVariantNumeric: "tabular-nums", color: C_INK_DIM, fontSize: 10, marginBottom: 5 }}>
            {String(hovered.hour).padStart(2, "0")}:00 – {String(hovered.hour).padStart(2, "0")}:59
          </div>
          {hourly
            .map(r => ({ user_id: r.user_id, display_name: r.display_name, count: r.hours[hovered.hour] }))
            .filter(s => s.count > 0)
            .sort((a, b) => b.count - a.count)
            .map(s => {
              const color = colorByUserId.get(s.user_id) ?? fallback;
              return (
                <div key={s.user_id} style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 2 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
                    <span style={{ color: C_INK_DIM }}>{s.display_name}</span>
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color }}>{s.count}</span>
                </div>
              );
            })}
          {hourTotals[hovered.hour] === 0 && <div style={{ color: C_INK_FAINT }}>No activity</div>}
          <div style={{ borderTop: `1px solid ${C_LINE}`, marginTop: 5, paddingTop: 5, display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: C_INK_FAINT }}>Total</span>
            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{hourTotals[hovered.hour]}</span>
          </div>
        </div>
      )}

      {/* Legend + total */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C_LINE}` }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {hourly.map(r => {
            const color = colorByUserId.get(r.user_id) ?? fallback;
            return (
              <div key={r.user_id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 20, height: 2, borderRadius: 1, background: color }} />
                <span style={{ fontSize: 10, color: C_INK_DIM }}>{r.display_name}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: C_INK_FAINT, textTransform: "uppercase", letterSpacing: "0.1em" }}>Total today</span>
          <span style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 20, color: C_CLEAN, fontVariantNumeric: "tabular-nums" }}>{total.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

export default function ProgressPage() {
  const [data, setData]       = useState<ApiResponse | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [me, setMe]           = useState<{ role: string } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);
  const timerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then(r => r.json())
      .then(j => { if (j.ok) setMe({ role: j.role }); })
      .catch(() => {});
  }, []);

  async function rebuildSnapshot() {
    setRebuilding(true);
    setRebuildMsg(null);
    try {
      const r = await fetch("/api/snapshot/rebuild", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "rebuild failed");
      setRebuildMsg(`Snapshot rebuilt at ${new Date(j.generated_at).toLocaleTimeString()}`);
      load(); // refresh progress data too
    } catch (e) {
      setRebuildMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRebuilding(false);
    }
  }

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
      if (document.visibilityState === "visible") {
        load().then(scheduleNext);
      } else {
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

  // 7-day chart: grouped by silver data date (which ship-day was cleaned)
  const allDates7 = Array.from(new Set(reviewers.flatMap(r => r.daily.map(d => d.date)))).sort();
  const barData7: BarDatum[] = allDates7.map(date => {
    const breakdown = reviewers.map(r => ({
      slug:         r.slug,
      display_name: r.display_name,
      count:        r.daily.find(d => d.date === date)?.count ?? 0,
      color:        r.color,
    }));
    return { date, total: breakdown.reduce((s, b) => s + b.count, 0), breakdown };
  });

  // 30-day chart: grouped by updated_at date (the day the cleaning was done)
  const allDates30 = Array.from(new Set(reviewers.flatMap(r => r.daily30.map(d => d.date)))).sort();
  const barData30: BarDatum[] = allDates30.map(date => {
    const breakdown = reviewers.map(r => ({
      slug:         r.slug,
      display_name: r.display_name,
      count:        r.daily30.find(d => d.date === date)?.count ?? 0,
      color:        r.color,
    }));
    return { date, total: breakdown.reduce((s, b) => s + b.count, 0), breakdown };
  });

  const todayTotal = data.today.reduce((s, r) => s + r.count, 0);

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
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {rebuildMsg && (
            <span style={{ fontSize: 10, color: rebuildMsg.startsWith("Failed") ? "#d35454" : C_CLEAN, fontVariantNumeric: "tabular-nums" }}>
              {rebuildMsg}
            </span>
          )}
          {me?.role === "assigner" && (
            <button
              onClick={rebuildSnapshot}
              disabled={rebuilding}
              style={{
                fontSize: 10, padding: "5px 12px", borderRadius: 3,
                background: rebuilding ? C_LINE : C_ACCENT,
                color: rebuilding ? C_INK_FAINT : "#1a1207",
                border: "none", cursor: rebuilding ? "default" : "pointer",
                fontFamily: "inherit", fontWeight: 600,
                textTransform: "uppercase", letterSpacing: "0.1em",
              }}
            >
              {rebuilding ? "Rebuilding…" : "Rebuild snapshot"}
            </button>
          )}
          <span style={{ fontSize: 9.5, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums" }}>
            Refreshes every 60 s
          </span>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* Left: leaderboard */}
        <div style={{ width: 300, borderRight: `1px solid ${C_LINE}`, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "16px 20px" }}>
            <SectionLabel>Leaderboard</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {reviewers.map(r => (
                <div key={r.user_id} style={{ background: C_PANEL, border: `1px solid ${C_LINE}`, borderRadius: 4, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 30, height: 30, borderRadius: "50%", background: r.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#0b1014", flexShrink: 0 }}>
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

            {/* Recent reviews */}
            <div style={{ marginTop: 20 }}>
              <SectionLabel>Recent reviews</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
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
                        {row.updated_at.slice(11, 16)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right: charts + today table */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "auto", padding: "20px 36px", gap: 32 }}>

          {/* Today's breakdown table */}
          <div>
            <SectionLabel>Today&apos;s cleaned</SectionLabel>
            {data.today.length === 0 ? (
              <div style={{ marginTop: 12, fontSize: 11, color: C_INK_FAINT }}>No cleaning activity yet today.</div>
            ) : (
              <div style={{ marginTop: 12, border: `1px solid ${C_LINE}`, borderRadius: 4, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: C_BG2 }}>
                      <th style={thStyle}>Mapmaker</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Days cleaned</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Last update</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.today.map((row, i) => {
                      const rev = reviewers.find(r => r.user_id === row.user_id);
                      return (
                        <tr key={row.user_id} style={{ background: i % 2 === 0 ? C_PANEL : "transparent", borderTop: `1px solid ${C_LINE}` }}>
                          <td style={tdStyle}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: rev?.color ?? C_INK_FAINT, flexShrink: 0 }} />
                              {row.display_name}
                            </div>
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums", color: C_CLEAN, fontWeight: 600 }}>
                            {row.count}
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums", color: C_INK_FAINT }}>
                            {row.last_updated_at.slice(11, 16)}
                          </td>
                        </tr>
                      );
                    })}
                    <tr style={{ borderTop: `1px solid ${C_LINE}`, background: C_BG2 }}>
                      <td style={{ ...tdStyle, color: C_INK_FAINT, fontWeight: 500 }}>Total</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C_CLEAN }}>{todayTotal}</td>
                      <td style={tdStyle} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 7-day bar chart — by silver data date (which ship-days were cleaned) */}
          <div>
            <SectionLabel>Last 7 days — ship-days cleaned</SectionLabel>
            <div style={{ fontSize: 10, color: C_INK_FAINT, marginTop: 4, marginBottom: 14 }}>
              Grouped by the silver data date (which day of data was cleaned)
            </div>
            <ActivityBarChart data={barData7} reviewers={reviewers} maxBars={7} />
          </div>

          {/* 30-day bar chart — by updated_at date (when the cleaning was done) */}
          <div>
            <SectionLabel>Last 30 days — cleaning activity</SectionLabel>
            <div style={{ fontSize: 10, color: C_INK_FAINT, marginTop: 4, marginBottom: 14 }}>
              Grouped by when each mapmaker actually did the cleaning
            </div>
            <ActivityBarChart data={barData30} reviewers={reviewers} maxBars={30} />
          </div>

          {/* Today's ship-day updates — hourly time-series, stacked by team mate */}
          <div style={{ minWidth: 0, width: "100%" }}>
            <SectionLabel>Today — hourly activity</SectionLabel>
            <div style={{ fontSize: 10, color: C_INK_FAINT, marginTop: 4, marginBottom: 14 }}>
              Ship-days updated 00:00 → 23:59 today (server time), stacked by team mate
            </div>
            <TodayHourlyChart hourly={data.today_hourly ?? []} reviewers={reviewers} total={todayTotal} />
          </div>

          {reviewers.length === 0 && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C_INK_FAINT, fontSize: 11 }}>
              No review activity yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "7px 14px",
  textAlign: "left",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: C_INK_FAINT,
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 11,
  color: C_INK,
};

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
