"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAssignments, type DraftAssignment } from "@/app/coverage/AssignmentContext";

type Status = "queued" | "in_progress" | "done" | "blocked";
type Role = "assigner" | "cleaner" | "viewer";

const STATUS_COLORS: Record<Status, string> = {
  queued:      "#5a6d7c",
  in_progress: "#e8c170",
  done:        "#4ea374",
  blocked:     "#d35454",
};
const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued", in_progress: "In progress", done: "Done", blocked: "Blocked",
};
const ALL_STATUSES: Status[] = ["queued", "in_progress", "done", "blocked"];

// Live-data team slugs — shown first and highlighted in the filter bar
const LIVE_DATA_SLUGS = ["nick", "ai-ai", "kim"];

const C_BG        = "#0b1014";
const C_BG2       = "#0f161c";
const C_PANEL     = "#131c24";
const C_LINE      = "#162028";
const C_INK       = "#e7eef3";
const C_INK_DIM   = "#93a4b2";
const C_INK_FAINT = "#5a6d7c";
const C_ACCENT    = "#e8c170";

function toStatus(s: string | undefined): Status {
  if (s === "in_progress" || s === "done" || s === "blocked") return s;
  return "queued";
}

// Next status for cleaner self-update cycle
const CLEANER_NEXT: Partial<Record<Status, Status>> = {
  queued:      "in_progress",
  in_progress: "done",
};

async function patchAssignment(id: string, patch: Record<string, string>) {
  const res = await fetch(`/api/sheets/assignments/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json();
}

export default function QueuePage() {
  const { drafts, loading, reload } = useAssignments();
  const [selected, setSelected] = useState<string | null>(null);
  const [me, setMe] = useState<{ role: Role; slug: string | null; display_name: string | null } | null>(null);
  const [filterSlug, setFilterSlug] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then(r => r.json())
      .then(j => { if (j.ok) setMe({ role: j.role, slug: j.slug, display_name: j.display_name }); })
      .catch(() => {});
  }, []);

  const isAssigner = me?.role === "assigner";
  const mySlug = me?.slug ?? null;

  // Derive unique assignees from loaded drafts (for filter pills)
  const assigneeSlugs = useMemo(() => {
    const seen = new Set<string>();
    const liveFirst: string[] = [];
    const rest: string[] = [];
    for (const d of drafts) {
      if (d.assignee && !seen.has(d.assignee)) {
        seen.add(d.assignee);
        if (LIVE_DATA_SLUGS.includes(d.assignee)) liveFirst.push(d.assignee);
        else rest.push(d.assignee);
      }
    }
    return [...liveFirst, ...rest];
  }, [drafts]);

  // Cleaners only see their own; assigners can filter by teammate
  const visibleDrafts = isAssigner
    ? (filterSlug ? drafts.filter(d => d.assignee === filterSlug) : drafts)
    : drafts.filter(d => d.assignee === mySlug);

  const active = visibleDrafts.filter(d => toStatus(d.status) !== "done");
  const done   = visibleDrafts.filter(d => toStatus(d.status) === "done");
  const selDraft = drafts.find(d => d.id === selected) ?? null;

  const handleStatusChange = useCallback(async (id: string, status: Status) => {
    const res = await patchAssignment(id, { status });
    if (res.ok) reload();
    else console.error("[queue] status update failed:", res.error);
  }, [reload]);

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, background: C_BG, color: C_INK }}>
      {/* Sidebar */}
      <div style={{ width: 300, borderRight: `1px solid ${C_LINE}`, display: "flex", flexDirection: "column", flexShrink: 0, overflowY: "auto", background: C_BG2 }}>
        <div style={{ padding: "20px 20px 14px", borderBottom: `1px solid ${C_LINE}`, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: C_ACCENT, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ display: "inline-block", width: 14, height: 1, background: C_ACCENT }} />
              {isAssigner ? "All Assignments" : "My Assignments"}
            </div>
            <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 20, color: C_INK, letterSpacing: "-0.01em" }}>
              Queue
            </div>
            {me?.display_name && (
              <div style={{ fontSize: 9.5, color: C_INK_FAINT, marginTop: 3 }}>
                {me.display_name} · {isAssigner ? "Admin" : "Cleaner"}
              </div>
            )}
          </div>
          <button
            onClick={reload}
            disabled={loading}
            style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT, background: "none", border: `1px solid ${C_LINE}`, borderRadius: 2, padding: "4px 8px", cursor: loading ? "default" : "pointer", fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {/* Assignee filter pills — admin only */}
        {isAssigner && assigneeSlugs.length > 0 && (
          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C_LINE}`, display: "flex", flexWrap: "wrap", gap: 5 }}>
            <FilterPill
              label="All"
              active={filterSlug === null}
              onClick={() => setFilterSlug(null)}
            />
            {assigneeSlugs.map(slug => (
              <FilterPill
                key={slug}
                label={slug.charAt(0).toUpperCase() + slug.slice(1)}
                active={filterSlug === slug}
                highlight={LIVE_DATA_SLUGS.includes(slug)}
                onClick={() => setFilterSlug(prev => prev === slug ? null : slug)}
                count={drafts.filter(d => d.assignee === slug && toStatus(d.status) !== "done").length}
              />
            ))}
          </div>
        )}

        {loading && drafts.length === 0 ? (
          <div style={{ padding: "10px 16px", fontSize: 11, color: C_INK_FAINT }}>Loading…</div>
        ) : (
          <>
            <SidebarSection label={`Active (${active.length})`} />
            {active.length === 0 && (
              <div style={{ padding: "10px 16px", fontSize: 11, color: C_INK_FAINT }}>
                {isAssigner ? "No active assignments." : "Nothing assigned to you yet."}
              </div>
            )}
            {active.map(d => (
              <DraftRow
                key={d.id}
                draft={d}
                active={selected === d.id}
                isAssigner={isAssigner}
                onClick={() => setSelected(d.id)}
                onStatusChange={handleStatusChange}
              />
            ))}

            {done.length > 0 && (
              <>
                <SidebarSection label={`Done (${done.length})`} style={{ marginTop: 1 }} />
                {done.map(d => (
                  <DraftRow
                    key={d.id}
                    draft={d}
                    active={selected === d.id}
                    isAssigner={isAssigner}
                    onClick={() => setSelected(d.id)}
                    onStatusChange={handleStatusChange}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {selDraft ? (
          <DraftDetail
            draft={selDraft}
            isAssigner={isAssigner}
            onClose={() => setSelected(null)}
            onStatusChange={handleStatusChange}
            onReload={reload}
          />
        ) : (
          <EmptyState isAssigner={isAssigner} />
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

function DraftRow({ draft, active, isAssigner, onClick, onStatusChange }: {
  draft: DraftAssignment;
  active: boolean;
  isAssigner: boolean;
  onClick: () => void;
  onStatusChange: (id: string, status: Status) => void;
}) {
  const status = toStatus(draft.status);
  const color = STATUS_COLORS[status];
  const nextStatus = CLEANER_NEXT[status];

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
          {isAssigner && draft.assignee && <span style={{ marginLeft: 6, color: C_INK_DIM }}>· {draft.assignee}</span>}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginTop: 1 }}>
        {/* Cleaner: tap to advance status */}
        {!isAssigner && nextStatus && status !== "done" && (
          <button
            onClick={e => { e.stopPropagation(); onStatusChange(draft.id, nextStatus); }}
            style={{ fontSize: 9, padding: "2px 6px", borderRadius: 2, background: `${STATUS_COLORS[nextStatus]}22`, color: STATUS_COLORS[nextStatus], border: `1px solid ${STATUS_COLORS[nextStatus]}44`, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "inherit" }}
          >
            Mark {STATUS_LABEL[nextStatus]}
          </button>
        )}
        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 2, background: `${color}22`, color, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          {STATUS_LABEL[status]}
        </span>
      </div>
    </div>
  );
}

function DraftDetail({ draft, isAssigner, onClose, onStatusChange, onReload }: {
  draft: DraftAssignment;
  isAssigner: boolean;
  onClose: () => void;
  onStatusChange: (id: string, status: Status) => void;
  onReload: () => void;
}) {
  const status = toStatus(draft.status);
  const color = STATUS_COLORS[status];
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState(draft.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function saveNotes() {
    setSaving(true);
    const res = await patchAssignment(draft.id, { notes });
    setSaving(false);
    if (res.ok) { setEditingNotes(false); onReload(); }
    else console.error("[queue] notes save failed:", res.error);
  }

  const nextStatus = CLEANER_NEXT[status];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "20px 36px 16px", borderBottom: `1px solid ${C_LINE}`, background: "linear-gradient(180deg, rgba(232,193,112,0.02), transparent 80%)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: C_ACCENT, marginBottom: 5, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "inline-block", width: 14, height: 1, background: C_ACCENT }} />
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
          {draft.created_by && <Field label="Assigned by" value={draft.created_by} />}

          {/* Status: admins get a dropdown, cleaners get advance button */}
          <div>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginBottom: 6 }}>Status</div>
            {isAssigner ? (
              <select
                value={status}
                onChange={e => onStatusChange(draft.id, e.target.value as Status)}
                style={{ padding: "4px 8px", background: C_BG, border: `1px solid ${C_LINE}`, borderRadius: 3, fontSize: 11, color: C_INK, fontFamily: "inherit", cursor: "pointer" }}
              >
                {ALL_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, padding: "3px 10px", borderRadius: 2, background: `${color}22`, color, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>
                  {STATUS_LABEL[status]}
                </span>
                {nextStatus && (
                  <button
                    onClick={() => onStatusChange(draft.id, nextStatus)}
                    style={{ fontSize: 9, padding: "3px 8px", borderRadius: 2, background: `${STATUS_COLORS[nextStatus]}22`, color: STATUS_COLORS[nextStatus], border: `1px solid ${STATUS_COLORS[nextStatus]}44`, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "inherit" }}
                  >
                    Mark {STATUS_LABEL[nextStatus]}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Notes */}
        <div style={{ borderTop: `1px solid ${C_LINE}`, paddingTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT }}>Notes</div>
            {isAssigner && !editingNotes && (
              <button
                onClick={() => setEditingNotes(true)}
                style={{ fontSize: 9, color: C_INK_FAINT, background: "none", border: `1px solid ${C_LINE}`, borderRadius: 2, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.1em" }}
              >
                Edit
              </button>
            )}
          </div>
          {isAssigner && editingNotes ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={4}
                style={{ padding: "8px 10px", background: C_BG, border: `1px solid ${C_LINE}`, borderRadius: 3, fontSize: 11, color: C_INK, fontFamily: "inherit", resize: "vertical", width: "100%", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={saveNotes}
                  disabled={saving}
                  style={{ fontSize: 10, padding: "5px 14px", borderRadius: 3, background: C_ACCENT, color: "#1a1207", border: "none", cursor: saving ? "default" : "pointer", fontFamily: "inherit", fontWeight: 600, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => { setEditingNotes(false); setNotes(draft.notes ?? ""); }}
                  style={{ fontSize: 10, padding: "5px 14px", borderRadius: 3, background: "transparent", color: C_INK_FAINT, border: `1px solid ${C_LINE}`, cursor: "pointer", fontFamily: "inherit" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: draft.notes ? C_INK_DIM : C_INK_FAINT, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {draft.notes || "No notes."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ isAssigner }: { isAssigner: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: "0 36px" }}>
      <div style={{ fontSize: 11, color: C_INK_FAINT, lineHeight: 1.8 }}>
        {isAssigner
          ? <>Select an assignment from the list,<br />or drag cells on the Cleanliness grid to create one.</>
          : <>Select an assignment from the list<br />to see details and update its status.</>}
      </div>
    </div>
  );
}

function FilterPill({ label, active, highlight, onClick, count }: {
  label: string;
  active: boolean;
  highlight?: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 9.5, padding: "3px 8px", borderRadius: 12,
        border: `1px solid ${active ? C_ACCENT : highlight ? "#e8c17044" : C_LINE}`,
        background: active ? `${C_ACCENT}22` : "transparent",
        color: active ? C_ACCENT : highlight ? "#e8c170aa" : C_INK_FAINT,
        cursor: "pointer", fontFamily: "inherit",
        display: "flex", alignItems: "center", gap: 4,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span style={{ fontSize: 8.5, background: active ? C_ACCENT : C_LINE, color: active ? "#1a1207" : C_INK_FAINT, borderRadius: 8, padding: "0 4px", lineHeight: "14px" }}>
          {count}
        </span>
      )}
    </button>
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
