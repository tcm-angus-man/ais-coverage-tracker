"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useAssignments, type DraftAssignment } from "@/app/coverage/AssignmentContext";
import { fetchWithRetry } from "@/app/coverage/CoverageLoader";
import { indexPayload } from "@/app/coverage/indexPayload";
import { buildGapRuns, gapTotals, matchesShipQuery, sortGapRuns, type GapRun } from "@/app/coverage/gaps";
import { ASSIGNABLE_MEMBERS, LIVE_DATA_TEAM } from "@/app/coverage/team";
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

const dateStyle: React.CSSProperties = {
  background: C_PANEL, color: C_INK, border: `1px solid ${C_LINE}`,
  borderRadius: 2, padding: "3px 7px", fontSize: 11, fontFamily: "inherit",
};

export default function GapsPage() {
  const { data: session } = useSession();
  const { drafts, addDraft } = useAssignments();
  const [payload, setPayload] = useState<CoveragePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [unassignedOnly, setUnassignedOnly] = useState(true);
  const [showBlackout, setShowBlackout] = useState(false);
  const [assignee, setAssignee] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Set<1 | 2 | 3 | 4>>(new Set());
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const canAssign = session?.user?.role === "assigner" || session?.user?.can_assign === true;

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

  // Ship-day -> assignment identity, so a run never spans an assignment boundary.
  const assignmentAt = useMemo(() => {
    if (!indexed) return undefined;
    const byRow = new Map<number, { start: string; end: string; key: string }[]>();
    const rowIdxByShipId = new Map<number, number>();
    const rowIdxByMmsi = new Map<number, number>();
    indexed.rows.forEach((row, i) => {
      for (const m of row.members) rowIdxByShipId.set(m.id, i);
      if (row.mmsi > 0 && !rowIdxByMmsi.has(row.mmsi)) rowIdxByMmsi.set(row.mmsi, i);
    });
    for (const a of drafts) {
      if (!a.date_start || !a.date_end) continue;
      if ((a.status ?? "queued") === "done") continue;
      const ri = a.ship_id ? rowIdxByShipId.get(a.ship_id) : (a.ship_mmsi ? rowIdxByMmsi.get(a.ship_mmsi) : undefined);
      if (ri === undefined) continue;
      const list = byRow.get(ri) ?? [];
      list.push({ start: a.date_start, end: a.date_end, key: `${a.assignee ?? ""}|${a.status ?? "queued"}` });
      byRow.set(ri, list);
    }
    return (rowIdx: number, date: string): string | null => {
      const list = byRow.get(rowIdx);
      if (!list) return null;
      for (const r of list) if (date >= r.start && date <= r.end) return r.key;
      return null;
    };
  }, [indexed, drafts]);

  const { high, blackout, totals } = useMemo(() => {
    if (!indexed) return { high: [] as GapRun[], blackout: [] as GapRun[], totals: null };
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
    const visible = (r: GapRun) =>
      (!unassignedOnly || r.assignmentKey === null) &&
      (!assignee || (r.assignmentKey ?? "").startsWith(`${assignee}|`));
    return {
      high: runs.filter(r => r.classification === "high" && visible(r)),
      blackout: runs.filter(r => r.classification === "blackout"),
      totals: t,
    };
  }, [indexed, assignmentAt, unassignedOnly, assignee, tiers, query, dateFrom, dateTo]);

  const assigneeList = useMemo(() => {
    const s = new Set<string>();
    for (const d of drafts) if (d.assignee) s.add(d.assignee);
    return Array.from(s).sort();
  }, [drafts]);

  // `who` is always a slug from ASSIGNABLE_MEMBERS — the same roster the grid's
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

  const filtered = query.trim() !== "" || tiers.size > 0 || dateFrom !== "" || dateTo !== "";

  if (error && !payload) return <Centered>Failed to load: {error}</Centered>;
  if (!indexed || !totals) return <Centered>Loading coverage data…</Centered>;

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
          <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center", fontSize: 11 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", color: C_INK_DIM }}>
              <input type="checkbox" checked={unassignedOnly} onChange={e => setUnassignedOnly(e.target.checked)} />
              unassigned only
            </label>
            <select
              value={assignee}
              onChange={e => setAssignee(e.target.value)}
              style={{ background: C_PANEL, color: C_INK, border: `1px solid ${C_LINE}`, borderRadius: 2, padding: "3px 8px", fontSize: 11, fontFamily: "inherit" }}
            >
              <option value="">all assignees</option>
              {assigneeList.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 36px", fontSize: 11, color: "#d35454" }}>{error}</div>
      )}

      <Section title="High — actionable now" hint="Silver data exists and carries anomaly flags. The team cleans silver, so these are the ship-days that can actually be worked.">
        <RunTable runs={high} canAssign={canAssign} busy={busy} onAssign={assignRun} />
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
        {showBlackout ? <RunTable runs={blackout} canAssign={false} busy={null} onAssign={undefined} /> : null}
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

function RunTable({ runs, canAssign, busy, onAssign }: { runs: GapRun[]; canAssign: boolean; busy: string | null; onAssign?: (r: GapRun, who: string) => void }) {
  if (runs.length === 0) {
    return <div style={{ fontSize: 11, color: C_INK_FAINT, padding: "8px 0" }}>Nothing here.</div>;
  }
  return (
    <div style={{ border: `1px solid ${C_LINE}`, borderRadius: 3, overflow: "hidden" }}>
      {runs.slice(0, 500).map(r => {
        const key = `${r.rowIdx}|${r.dateStart}`;
        return (
          <div
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 14, padding: "7px 12px", borderBottom: `1px solid ${C_LINE}`, background: C_PANEL, fontSize: 11.5 }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 1, background: r.classification === "high" ? C_HIGH : C_BLACKOUT, flexShrink: 0 }} />
            <span style={{ flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.shipName}</span>
            <span style={{ width: 190, flexShrink: 0, color: C_INK_FAINT, fontSize: 10, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              MMSI {r.mmsi > 0 ? r.mmsi : "—"} · IMO {r.imo || "—"}
            </span>
            <span style={{ color: C_INK_DIM, fontVariantNumeric: "tabular-nums" }}>{r.dateStart} → {r.dateEnd}</span>
            <span style={{ color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", width: 52, textAlign: "right" }}>{r.days}d</span>
            <span style={{ width: 150, textAlign: "right", color: C_INK_FAINT, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.assignmentKey ? r.assignmentKey.replace("|", " · ") : ""}
            </span>
            {onAssign && canAssign && r.assignmentKey === null ? (
              <select
                value=""
                disabled={busy === key}
                onChange={e => { const v = e.target.value; e.currentTarget.value = ""; if (v) onAssign(r, v); }}
                style={{ width: 96, padding: "2px 6px", fontSize: 10, cursor: "pointer", borderRadius: 2, border: `1px solid ${C_LINE}`, background: C_ACCENT, color: "#1a1207", fontWeight: 600, fontFamily: "inherit" }}
              >
                <option value="">{busy === key ? "…" : "assign to…"}</option>
                {ASSIGNABLE_MEMBERS.filter(m => LIVE_DATA_TEAM.has(m.slug)).map(m => (
                  <option key={m.slug} value={m.slug}>{m.display_name}</option>
                ))}
                {ASSIGNABLE_MEMBERS.filter(m => !LIVE_DATA_TEAM.has(m.slug)).map(m => (
                  <option key={m.slug} value={m.slug}>{m.display_name}</option>
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
