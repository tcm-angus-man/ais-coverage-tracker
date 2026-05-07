"use client";

import { useState } from "react";
import { useAssignments, type DraftAssignment } from "@/app/coverage/AssignmentContext";

type Status = "queued" | "in_progress" | "done" | "blocked";

const STATUS_COLORS: Record<Status, string> = {
  queued:      "#5a6d7c",
  in_progress: "#e8c170",
  done:        "#4ea374",
  blocked:     "#d35454",
};
const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued", in_progress: "In progress", done: "Done", blocked: "Blocked",
};

const C_BG        = "#0b1014";
const C_BG2       = "#0f161c";
const C_PANEL     = "#131c24";
const C_LINE      = "#162028";
const C_INK       = "#e7eef3";
const C_INK_DIM   = "#93a4b2";
const C_INK_FAINT = "#5a6d7c";

function toStatus(s: string | undefined): Status {
  if (s === "in_progress" || s === "done" || s === "blocked") return s;
  return "queued";
}

export default function QueuePage() {
  const { drafts, loading, reload } = useAssignments();
  const [selected, setSelected] = useState<string | null>(null);

  const active = drafts.filter(d => toStatus(d.status) !== "done");
  const done   = drafts.filter(d => toStatus(d.status) === "done");
  const selDraft = drafts.find(d => d.id === selected) ?? null;

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, background: C_BG, color: C_INK }}>
      {/* Sidebar */}
      <div style={{ width: 300, borderRight: `1px solid ${C_LINE}`, display: "flex", flexDirection: "column", flexShrink: 0, overflowY: "auto", background: C_BG2 }}>
        <div style={{ padding: "20px 20px 14px", borderBottom: `1px solid ${C_LINE}`, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--accent)", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ display: "inline-block", width: 14, height: 1, background: "var(--accent)" }} />
              Assignments
            </div>
            <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 20, color: C_INK, letterSpacing: "-0.01em" }}>
              Queue
            </div>
          </div>
          <button
            onClick={reload}
            disabled={loading}
            style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT, background: "none", border: `1px solid ${C_LINE}`, borderRadius: 2, padding: "4px 8px", cursor: loading ? "default" : "pointer", fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {loading && drafts.length === 0 ? (
          <div style={{ padding: "10px 16px", fontSize: 11, color: C_INK_FAINT }}>Loading…</div>
        ) : (
          <>
            <SidebarSection label={`Active (${active.length})`} />
            {active.length === 0 && (
              <div style={{ padding: "10px 16px", fontSize: 11, color: C_INK_FAINT }}>
                No active assignments.
              </div>
            )}
            {active.map(d => (
              <DraftRow key={d.id} draft={d} active={selected === d.id} onClick={() => setSelected(d.id)} />
            ))}

            {done.length > 0 && (
              <>
                <SidebarSection label={`Done (${done.length})`} style={{ marginTop: 1 }} />
                {done.map(d => (
                  <DraftRow key={d.id} draft={d} active={selected === d.id} onClick={() => setSelected(d.id)} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {selDraft ? (
          <DraftDetail draft={selDraft} onClose={() => setSelected(null)} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: "0 36px" }}>
            <div style={{ fontSize: 11, color: C_INK_FAINT, lineHeight: 1.8 }}>
              Select an assignment from the list,<br />
              or drag cells on the Cleanliness grid to create one.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SidebarSection({ label, style }: { label: string; style?: React.CSSProperties }) {
  return (
    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT, padding: "7px 16px", background: C_BG2, borderBottom: `1px solid ${C_LINE}`, position: "sticky", top: 0, zIndex: 1, ...style }}>
      {label}
    </div>
  );
}

function DraftRow({ draft, active, onClick }: { draft: DraftAssignment; active: boolean; onClick: () => void }) {
  const status = toStatus(draft.status);
  const color = STATUS_COLORS[status];
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "flex-start", padding: "9px 16px 9px 13px",
        cursor: "pointer", borderBottom: `1px solid ${C_LINE}`,
        borderLeft: `3px solid ${color}`,
        background: active ? C_PANEL : "transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = C_PANEL; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <div style={{ flex: 1, minWidth: 0, paddingLeft: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 500, color: C_INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{draft.ship_name}</div>
        <div style={{ fontSize: 9.5, color: C_INK_FAINT, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
          {draft.date_start} → {draft.date_end}
          {draft.assignee && <span style={{ marginLeft: 6, color: C_INK_DIM }}>· {draft.assignee}</span>}
        </div>
      </div>
      <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 2, background: `${color}22`, color, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0, marginTop: 1 }}>
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}

function DraftDetail({ draft, onClose }: { draft: DraftAssignment; onClose: () => void }) {
  const status = toStatus(draft.status);
  const color = STATUS_COLORS[status];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "20px 36px 16px", borderBottom: `1px solid ${C_LINE}`, background: "linear-gradient(180deg, rgba(232,193,112,0.02), transparent 80%)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--accent)", marginBottom: 5, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "inline-block", width: 14, height: 1, background: "var(--accent)" }} />
            Assignment
          </div>
          <h2 style={{ fontFamily: "Fraunces, serif", fontWeight: 400, fontSize: 24, margin: "0 0 3px", letterSpacing: "-0.02em", color: C_INK }}>{draft.ship_name}</h2>
          <div style={{ fontSize: 10, color: C_INK_DIM, fontVariantNumeric: "tabular-nums" }}>{draft.date_start} → {draft.date_end}</div>
        </div>
        <button onClick={onClose} style={{ fontSize: 14, color: C_INK_FAINT, background: "none", border: "none", cursor: "pointer", padding: 4 }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 36px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
          <Field label="Cruise line" value={draft.cruise_line} />
          <Field label="Created" value={draft.created_at ? new Date(draft.created_at).toLocaleDateString() : "—"} />
          <Field label="MMSI" value={String(draft.ship_mmsi)} mono />
          <Field label="Assignee" value={draft.assignee ?? "—"} />
          {draft.created_by && <Field label="Created by" value={draft.created_by} />}
          <div>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginBottom: 6 }}>Status</div>
            <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 2, background: `${color}22`, color, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>
              {STATUS_LABEL[status]}
            </span>
          </div>
        </div>

        {draft.notes && (
          <div style={{ borderTop: `1px solid ${C_LINE}`, paddingTop: 16 }}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginBottom: 8 }}>Notes</div>
            <div style={{ fontSize: 11, color: C_INK_DIM, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{draft.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 12, color: C_INK, fontVariantNumeric: mono ? "tabular-nums" : undefined }}>{value}</div>
    </div>
  );
}
