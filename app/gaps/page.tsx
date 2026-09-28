"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useAssignments, type DraftAssignment } from "@/app/coverage/AssignmentContext";
import { fetchWithRetry } from "@/app/coverage/CoverageLoader";
import { indexPayload } from "@/app/coverage/indexPayload";
import {
  actionsFor, buildAssignmentIndex, buildGapRuns, confirmText, gapTotals, inView, matchesShipQuery, runState,
  snapshotAsOf, sortGapRuns, visibleDays, type GapRun, type GapView, type RunAction,
} from "@/app/coverage/gaps";
import { computeSilverKpis, type SilverKpis } from "@/app/coverage/kpis";
import { ASSIGNABLE_MEMBERS, ROSTER_GROUPS, isTeamRole } from "@/app/coverage/team";
import type { CoveragePayload } from "@/app/coverage/types";

const C_BG        = "#0b1014";
const C_BG2       = "#0f161c";
const C_PANEL     = "#131c24";
const C_LINE      = "#162028";
const C_INK       = "#e7eef3";
const C_INK_DIM   = "#93a4b2";
const C_INK_FAINT = "#5a6d7c";
const C_ACCENT    = "#e8c170";
const C_HIGH      = "#e8c170";
const C_BLACKOUT  = "#5a6d7c";
const C_SILVER    = "#4ea374"; // the grid's C_SILVER_OK

const dateStyle: React.CSSProperties = {
  background: C_PANEL, color: C_INK, border: `1px solid ${C_LINE}`,
  borderRadius: 2, padding: "3px 7px", fontSize: 11, fontFamily: "inherit",
};

export default function GapsPage() {
  const { data: session } = useSession();
  const { drafts, addDraft, updateDraft, reload } = useAssignments();
  const [payload, setPayload] = useState<CoveragePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<GapView>("unassigned");
  const [showBlackout, setShowBlackout] = useState(false);
  const [assignee, setAssignee] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Set<1 | 2 | 3 | 4>>(new Set());
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const canAct = isTeamRole(session?.user?.role);
  const mySlug = session?.user?.slug ?? "";

  useEffect(() => {
    const ac = new AbortController();
    // Same fetch as the grid. With Cache-Control: private, max-age=3600 the
    // browser usually serves this from cache when arriving from a grid tab.
    fetchWithRetry("/api/coverage", () => {}, ac.signal)
      .then(setPayload)
      .catch(e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, []);

  const indexed = useMemo(() => (payload ? indexPayload(payload) : null), [payload]);
  const dataAsOf = payload ? snapshotAsOf(payload) : "";

  // Ship-day -> owning assignment; runs split on assignment_id.
  const assignmentAt = useMemo(
    () => (indexed ? buildAssignmentIndex(indexed.rows, drafts) : undefined),
    [indexed, drafts],
  );

  const { runs, high, blackout, totals, silver } = useMemo(() => {
    if (!indexed) return { runs: [] as GapRun[], high: [] as GapRun[], blackout: [] as GapRun[], totals: null, silver: null as SilverKpis | null };
    // Tier and search narrow the ships; the date range narrows the days. Both
    // are applied before runs are built, so the totals below describe exactly
    // what is listed.
    const rowIdxs: number[] = [];
    indexed.rows.forEach((row, i) => {
      if (tiers.size > 0 && !row.members.some(m => tiers.has(m.tier))) return;
      if (!matchesShipQuery(row, query)) return;
      rowIdxs.push(i);
    });
    const runs = sortGapRuns(buildGapRuns({
      rowIdxs,
      rows: indexed.rows,
      dates: indexed.dates,
      voyageCells: indexed.voyage.cells,
      silverCells: indexed.silver.cells,
      assignmentAt,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }));
    const t = gapTotals(runs);
    // The Cleanliness tab's own calculation, narrowed by the same filters — one
    // cleanliness definition across the product. It is not the High queue: a
    // dirty silver day under a visible voyage is done in Merged, so never High.
    const { dates } = indexed;
    let from = 0, to = dates.length - 1;
    if (dateFrom) { from = dates.findIndex(d => d >= dateFrom); if (from < 0) from = dates.length; }
    if (dateTo) { while (to >= 0 && dates[to] > dateTo) to--; }
    const silverKpis = computeSilverKpis(rowIdxs, indexed.rows, dates, indexed.silver.cells, { from, to });
    const visible = (r: GapRun) =>
      inView(r, runState(r, dataAsOf), view, mySlug) &&
      (view !== "all" || !assignee || r.assignment?.assignee === assignee);
    return {
      runs,
      high: runs.filter(r => r.classification === "high" && visible(r)),
      blackout: runs.filter(r => r.classification === "blackout"),
      totals: t,
      silver: silverKpis,
    };
  }, [indexed, assignmentAt, view, mySlug, dataAsOf, assignee, tiers, query, dateFrom, dateTo]);

  const assigneeList = useMemo(() => {
    const s = new Set<string>();
    for (const d of drafts) if (d.assignee) s.add(d.assignee);
    return Array.from(s).sort();
  }, [drafts]);

  // `who` is always a slug from ROSTER_GROUPS — the same roster the grid's
  // assign modal uses, so /gaps can't write an assignee the team doesn't have.
  async function assignRun(run: GapRun, who: string) {
    if (!who) return;
    setBusy(`${run.rowIdx}|${run.dateStart}`);
    const id = crypto.randomUUID();
    const draft: DraftAssignment = {
      id,
      ship_id: run.shipId,
      ship_mmsi: run.mmsi,
      ship_name: run.shipName,
      cruise_line: run.cruiseLine,
      date_start: run.dateStart,
      date_end: run.dateEnd,
      created_at: new Date().toISOString(),
      assignee: who,
      status: "queued",
      notes: "",
    };
    addDraft(draft);
    try {
      // Same endpoint and shape the grid uses — identity is taken from the
      // session server-side, never from this body.
      const r = await fetch("/api/sheets/assignments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: id, ...draft, assignee: who, notes: "" }),
      }).then(res => res.json());
      if (!r.ok) setError(r.error ?? "assignment write failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Every action changes the WHOLE assignment; confirmText says so.
  async function actOnRun(run: GapRun, action: RunAction, to?: string) {
    const a = run.assignment;
    if (!a) return;
    const name = (slug: string) => ASSIGNABLE_MEMBERS.find(m => m.slug === slug)?.display_name ?? slug;
    const plan =
      action === "reassign" && to ? { verb: "Reassign", detail: `from ${name(a.assignee)} to ${name(to)}`, patch: { assignee: to } } :
      action === "unassign"       ? { verb: "Unassign", detail: `from ${name(a.assignee)}`, patch: { status: "cancelled" } } :
      action === "complete"       ? { verb: "Mark complete", patch: { status: "done" } } :
      action === "reopen"         ? { verb: "Reopen", patch: { status: "in_progress" } } :
      null;
    if (!plan) return;
    if (!window.confirm(confirmText({ verb: plan.verb, ref: a, visible: visibleDays(a.id, runs), detail: plan.detail }))) return;
    setBusy(a.id);
    try {
      const r = await fetch(`/api/sheets/assignments/${a.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan.patch),
      }).then(res => res.json());
      if (!r.ok) { setError(r.error ?? "assignment update failed"); reload(); return; }
      // Apply exactly what the server wrote, including the completed_at it stamped.
      updateDraft(a.id, r.updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      reload();
    } finally {
      setBusy(null);
    }
  }

  const filtered = query.trim() !== "" || tiers.size > 0 || dateFrom !== "" || dateTo !== "";

  if (error && !payload) return <Centered>Failed to load: {error}</Centered>;
  if (!indexed || !totals || !silver) return <Centered>Loading coverage data…</Centered>;

  return (
    <div style={{ height: "100%", overflow: "auto", background: C_BG, color: C_INK }}>
      <div style={{ padding: "14px 36px 12px", borderBottom: `1px solid ${C_LINE}`, background: C_BG2 }}>
        <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: C_ACCENT, marginBottom: 5 }}>
          AIS Coverage · Gaps
        </div>
        <h1 style={{ fontFamily: "Fraunces, serif", fontWeight: 400, fontSize: 26, margin: "0 0 2px", letterSpacing: "-0.02em" }}>
          Gaps <em style={{ fontStyle: "italic", fontWeight: 300, color: C_ACCENT }}>to clear</em>
        </h1>
        <p style={{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontWeight: 300, fontSize: 12, color: C_INK_DIM, margin: 0 }}>
          {filtered
            ? "Filtered view — totals describe the current filters, not the whole fleet."
            : "High and Blackout together are the Merged tab\u2019s unresolved population."}
        </p>

        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="ship, cruise line, IMO or MMSI"
            style={{ flex: "1 1 240px", maxWidth: 320, background: C_PANEL, color: C_INK, border: `1px solid ${C_LINE}`, borderRadius: 2, padding: "4px 9px", fontSize: 11, fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginRight: 4 }}>tier</span>
            {([1, 2, 3, 4] as const).map(t => {
              const on = tiers.has(t);
              return (
                <button
                  key={t}
                  onClick={() => setTiers(prev => { const n = new Set(prev); if (n.has(t)) n.delete(t); else n.add(t); return n; })}
                  style={{ padding: "3px 9px", fontSize: 10, cursor: "pointer", borderRadius: 2, fontFamily: "inherit", fontWeight: on ? 600 : 400, border: `1px solid ${on ? C_ACCENT : C_LINE}`, background: on ? C_ACCENT : "transparent", color: on ? "#1a1207" : C_INK_FAINT }}
                >
                  T{t}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11, color: C_INK_FAINT }}>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={dateStyle} />
            <span>→</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={dateStyle} />
          </div>
          {filtered && (
            <button
              onClick={() => { setQuery(""); setTiers(new Set()); setDateFrom(""); setDateTo(""); }}
              style={{ padding: "3px 10px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", borderRadius: 2, border: `1px solid ${C_LINE}`, background: "transparent", color: C_INK_DIM, fontFamily: "inherit" }}
            >
              clear
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 28, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
          <Stat value={totals.highDays.toLocaleString()} label={`high days · ${totals.highRuns.toLocaleString()} runs`} color={C_HIGH} />
          <Stat value={totals.blackoutDays.toLocaleString()} label={`blackout days · ${totals.blackoutRuns.toLocaleString()} runs`} color={C_BLACKOUT} />
          <div style={{ paddingLeft: 28, borderLeft: `1px solid ${C_LINE}` }} title="Same figure as the Cleanliness tab: silver ship-days with all four anomaly counts at zero. Not the High queue.">
            <Stat value={`${silver.cleanedPct}%`} label={`silver cleanliness · ${(silver.withData - silver.needsReview).toLocaleString()} of ${silver.withData.toLocaleString()} ship-days clean`} color={C_SILVER} />
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center", fontSize: 11 }}>
            <div style={{ display: "flex", gap: 3 }}>
              {([["unassigned", "Unassigned"], ["mine", "My work"], ["reopened", "Reopened"], ["all", "All"]] as const).map(([v, label]) => {
                const on = view === v;
                return (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    style={{ padding: "3px 10px", fontSize: 10, cursor: "pointer", borderRadius: 2, fontFamily: "inherit", fontWeight: on ? 600 : 400, border: `1px solid ${on ? C_ACCENT : C_LINE}`, background: on ? C_ACCENT : "transparent", color: on ? "#1a1207" : C_INK_FAINT }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {view === "all" && (
              <select
                value={assignee}
                onChange={e => setAssignee(e.target.value)}
                style={{ background: C_PANEL, color: C_INK, border: `1px solid ${C_LINE}`, borderRadius: 2, padding: "3px 8px", fontSize: 11, fontFamily: "inherit" }}
              >
                <option value="">all assignees</option>
                {assigneeList.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 36px", fontSize: 11, color: "#d35454" }}>{error}</div>
      )}

      <Section title="High — actionable now" hint="Silver data exists and carries anomaly flags. The team cleans silver, so these are the ship-days that can actually be worked.">
        <RunTable runs={high} dataAsOf={dataAsOf} allowAssign canAct={canAct} busy={busy} onAssign={assignRun} onAction={actOnRun} />
      </Section>

      <Section
        title="Blackout — not actionable"
        hint="No silver data for these ship-days, so there is nothing to clean — whether or not a voyage exists. Tracked to quantify true coverage gaps."
        right={
          <button
            onClick={() => setShowBlackout(v => !v)}
            style={{ padding: "3px 12px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", borderRadius: 2, border: `1px solid ${C_LINE}`, background: "transparent", color: C_INK_FAINT, fontFamily: "inherit" }}
          >
            {showBlackout ? "hide" : `show ${totals.blackoutRuns.toLocaleString()}`}
          </button>
        }
      >
        {showBlackout ? <RunTable runs={blackout} dataAsOf={dataAsOf} allowAssign={false} canAct={canAct} busy={busy} onAssign={undefined} onAction={actOnRun} /> : null}
      </Section>
    </div>
  );
}

function Section({ title, hint, right, children }: { title: string; hint: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ padding: "18px 36px 8px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK }}>{title}</div>
        <div style={{ fontSize: 10.5, color: C_INK_FAINT, flex: 1 }}>{hint}</div>
        {right}
      </div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

function RunTable({ runs, dataAsOf, allowAssign, canAct, busy, onAssign, onAction }: {
  runs: GapRun[];
  dataAsOf: string;
  allowAssign: boolean;
  canAct: boolean;
  busy: string | null;
  onAssign?: (r: GapRun, who: string) => void;
  onAction: (r: GapRun, action: RunAction, to?: string) => void;
}) {
  if (runs.length === 0) {
    return <div style={{ fontSize: 11, color: C_INK_FAINT, padding: "8px 0" }}>Nothing here.</div>;
  }
  const snapTime = dataAsOf ? new Date(dataAsOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const selectStyle: React.CSSProperties = { width: 96, padding: "2px 6px", fontSize: 10, cursor: "pointer", borderRadius: 2, border: `1px solid ${C_LINE}`, fontFamily: "inherit" };
  return (
    <div style={{ border: `1px solid ${C_LINE}`, borderRadius: 3, overflow: "hidden" }}>
      {runs.slice(0, 500).map(r => {
        const key = `${r.rowIdx}|${r.dateStart}`;
        const a = r.assignment;
        const state = runState(r, dataAsOf);
        const actions = actionsFor(state).filter(x => allowAssign || x !== "assign");
        const partial = a !== null && (a.dateStart !== r.dateStart || a.dateEnd !== r.dateEnd);
        const label =
          !a ? "" :
          state === "awaiting_snapshot" ? `${a.assignee} · done · awaiting snapshot` :
          state === "reopened" ? `${a.assignee} · reopened` :
          `${a.assignee} · ${a.status.replace("_", " ")}`;
        const labelTitle = state === "reopened"
          ? `Still dirty in the ${snapTime} snapshot, taken after this was completed.`
          : undefined;
        return (
          <div
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 14, padding: "7px 12px", borderBottom: `1px solid ${C_LINE}`, background: C_PANEL, fontSize: 11.5, opacity: state === "awaiting_snapshot" ? 0.55 : 1 }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 1, background: r.classification === "high" ? C_HIGH : C_BLACKOUT, flexShrink: 0 }} />
            <span style={{ flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.shipName}</span>
            <span style={{ width: 190, flexShrink: 0, color: C_INK_FAINT, fontSize: 10, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              MMSI {r.mmsi > 0 ? r.mmsi : "—"} · IMO {r.imo || "—"}
            </span>
            <span style={{ color: C_INK_DIM, fontVariantNumeric: "tabular-nums" }}>
              {r.dateStart} → {r.dateEnd}
              {partial && a && <span style={{ color: C_INK_FAINT, fontSize: 10 }}> · part of {a.dateStart} → {a.dateEnd}</span>}
            </span>
            <span style={{ color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", width: 52, textAlign: "right" }}>{r.days}d</span>
            <span title={labelTitle} style={{ width: 170, textAlign: "right", color: state === "reopened" ? C_ACCENT : C_INK_FAINT, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {label}
            </span>
            {canAct && onAssign && actions.includes("assign") ? (
              <select
                value=""
                disabled={busy === key}
                onChange={e => { const v = e.target.value; e.currentTarget.value = ""; if (v) onAssign(r, v); }}
                style={{ ...selectStyle, background: C_ACCENT, color: "#1a1207", fontWeight: 600 }}
              >
                <option value="">{busy === key ? "…" : "assign to…"}</option>
                {ROSTER_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.members.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
                  </optgroup>
                ))}
              </select>
            ) : canAct && a && actions.length > 0 ? (
              <select
                value=""
                disabled={busy === a.id}
                onChange={e => {
                  const v = e.target.value;
                  e.currentTarget.value = "";
                  if (!v) return;
                  const [act, to] = v.split(":");
                  onAction(r, act as RunAction, to);
                }}
                style={{ ...selectStyle, background: "transparent", color: C_INK_DIM }}
              >
                <option value="">{busy === a.id ? "…" : "actions…"}</option>
                {actions.includes("complete") && <option value="complete">Mark complete</option>}
                {actions.includes("reopen") && <option value="reopen">Reopen</option>}
                {actions.includes("unassign") && <option value="unassign">Unassign</option>}
                {actions.includes("reassign") && ROSTER_GROUPS.map(g => (
                  <optgroup key={g.label} label={`Reassign to · ${g.label}`}>
                    {g.members.filter(m => m.slug !== a.assignee).map(m => (
                      <option key={m.slug} value={`reassign:${m.slug}`}>{m.display_name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : <span style={{ width: 96 }} />}
          </div>
        );
      })}
      {runs.length > 500 && (
        <div style={{ padding: "7px 12px", fontSize: 10.5, color: C_INK_FAINT, background: C_PANEL }}>
          showing first 500 of {runs.length.toLocaleString()} runs — narrow with the filters above
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div>
      <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 26, letterSpacing: "-0.02em", color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", background: C_BG, color: C_INK_DIM, fontSize: 11 }}>
      {children}
    </div>
  );
}
