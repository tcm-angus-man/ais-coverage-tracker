"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Cell, CoveragePayload, Ship } from "./types";
import type { ShellMode } from "./CoverageShell";
import { useAssignments } from "./AssignmentContext";

const HEADER_H = 36;
const HEADER_W = 200;

type Density = "compact" | "default" | "roomy";
const DENSITY_SIZES: Record<Density, { w: number; h: number }> = {
  compact: { w: 5,  h: 10 },
  default: { w: 8,  h: 14 },
  roomy:   { w: 11, h: 20 },
};

// Design tokens (hex for canvas)
const C_BG        = "#0b1014";
const C_BG2       = "#0f161c";
const C_PANEL     = "#131c24";
const C_LINE      = "#162028";   // subtler than before
const C_LINE2     = "#1a2a36";   // for canvas grid lines
const C_INK       = "#e7eef3";
const C_INK_DIM   = "#93a4b2";
const C_INK_FAINT = "#5a6d7c";

const C_VISIBLE   = "#4ea374";
const C_DW        = "#e8c170";
const C_NO_AIS    = "#d35454";
const C_NEED_PROC = "#b8712a";
const C_SILVER_OK = "#4ea374";
const C_SILVER_NR = "#b8712a";
const C_MISSING   = "#111820";

// ---------- cell colour logic ----------
function voyageCellColor(cell: Cell): string | null {
  const { t, v, na, dw } = cell;
  if (t === 0) return null;
  const need_process = Math.max(0, t - v - na - dw);
  const max = Math.max(v, dw, na, need_process);
  if (max === 0) return null;
  if (v >= max)    return C_VISIBLE;
  if (dw >= max)   return C_DW;
  if (na >= max)   return C_NO_AIS;
  return C_NEED_PROC;
}

function silverCellColor(cell: Cell): string | null {
  if (cell.t === 0) return null;
  return (cell.dt + cell.dd + cell.sp + cell.ol) > 0 ? C_SILVER_NR : C_SILVER_OK;
}

// ---------- indexing ----------
type LayerMeta = { cells: (Cell | null)[][] };

type Indexed = {
  payload: CoveragePayload;
  ships: Ship[];
  dates: string[];
  silverDates: string[];
  silverDateOffset: number;
  voyage: LayerMeta;
  silver: LayerMeta;
  silverShipSet: Set<number>;
  cruiseLineList: string[];
};

function indexPayload(payload: CoveragePayload): Indexed {
  const { ships, dates } = payload;
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdx.set(dates[i], i);

  const silverShipSet = new Set<number>(Object.keys(payload.silver_cells).map(Number));

  const buildLayer = (layer: Record<string, Record<string, Cell>>): LayerMeta => {
    const cells: (Cell | null)[][] = [];
    for (const s of ships) {
      const row = layer[String(s.mmsi)];
      const arr: (Cell | null)[] = new Array(dates.length).fill(null);
      if (row) for (const d in row) { const i = dateIdx.get(d); if (i !== undefined) arr[i] = row[d]; }
      cells.push(arr);
    }
    return { cells };
  };

  const SILVER_START = "2025-07-01";
  const silverDateOffset = Math.max(0, dates.findIndex(d => d >= SILVER_START));
  const silverDates = dates.slice(silverDateOffset);

  const clSet = new Set<string>();
  for (const s of ships) if (s.cruise_line) clSet.add(s.cruise_line);
  const cruiseLineList = Array.from(clSet).sort();

  return { payload, ships, dates, silverDates, silverDateOffset, voyage: buildLayer(payload.voyage_cells), silver: buildLayer(payload.silver_cells), silverShipSet, cruiseLineList };
}

// ---------- diagonal split ----------
function drawDiagonalCell(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, vc: string | null, sc: string | null) {
  const x2 = x + w, y2 = y + h;
  ctx.fillStyle = vc ?? C_MISSING;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y); ctx.lineTo(x2, y2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = sc ?? C_MISSING;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.lineTo(x, y2); ctx.closePath(); ctx.fill();
}

// ---------- types ----------
type SortKey = "name" | "coverage" | "activity" | "imo" | "cruise_line";

type TooltipState = { x: number; y: number; ship: Ship; date: string; voyage?: Cell; silver?: Cell } | null;

type DragState = { r0: number; c0: number; r1: number; c1: number } | null;

const SORT_OPTIONS: { k: SortKey; label: string }[] = [
  { k: "name",       label: "Name A→Z" },
  { k: "coverage",   label: "Coverage %" },
  { k: "activity",   label: "Last activity" },
  { k: "imo",        label: "IMO number" },
  { k: "cruise_line", label: "Cruise line" },
];

const DENSITY_OPTIONS: { k: Density; label: string }[] = [
  { k: "compact", label: "Compact" },
  { k: "default", label: "Default" },
  { k: "roomy",   label: "Roomy" },
];

// ---------- component ----------
export default function CoverageGrid({ payload, mode }: { payload: CoveragePayload; mode: ShellMode }) {
  const indexed = useMemo(() => indexPayload(payload), [payload]);
  const { ships, dates, silverDates, silverDateOffset, voyage, silver, silverShipSet, cruiseLineList } = indexed;
  const { addDraft } = useAssignments();

  const scrollRef    = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const scrollPosRef = useRef({ x: 0, y: 0 });
  const isDragging   = useRef(false);

  const [viewport,    setViewport]    = useState({ w: 0, h: 0 });
  const [,            setRenderTick]  = useState(0);
  const [filter,      setFilter]      = useState("");
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set());
  const [inServiceOnly, setInServiceOnly] = useState(false);
  const [sort,        setSort]        = useState<SortKey>("name");
  const [tooltip,     setTooltip]     = useState<TooltipState>(null);
  const [drag,        setDrag]        = useState<DragState>(null);
  const [assignModal, setAssignModal] = useState<{ ship: Ship; dateStart: string; dateEnd: string } | null>(null);
  const [density, setDensity] = useState<Density>("default");

  const { w: CELL_W, h: CELL_H } = DENSITY_SIZES[density];

  const isSilver = mode === "silver";
  const activeDates      = isSilver ? silverDates : dates;
  const activeDateOffset = isSilver ? silverDateOffset : 0;

  // Toggle a cruise line in/out of the multi-select set
  const toggleLine = useCallback((cl: string) => {
    setSelectedLines(prev => {
      const next = new Set(prev);
      if (next.has(cl)) next.delete(cl); else next.add(cl);
      return next;
    });
  }, []);

  // Filtered + sorted ship index list
  const baseShipIdx = useMemo(() => {
    let idxs = ships.map((_, i) => i).filter(i => {
      const s = ships[i];
      if (isSilver && !silverShipSet.has(s.mmsi)) return false;
      if (inServiceOnly && !s.in_service) return false;
      if (selectedLines.size > 0 && !selectedLines.has(s.cruise_line)) return false;
      if (filter.trim()) {
        const q = filter.toLowerCase();
        return s.display_name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.cruise_line.toLowerCase().includes(q) || String(s.mmsi).includes(q);
      }
      return true;
    });

    if (sort === "coverage") {
      idxs.sort((a, b) => {
        const cov = (i: number) => {
          const layer = isSilver ? silver : voyage;
          const start = isSilver ? silverDateOffset : 0;
          let hit = 0;
          for (let d = start; d < dates.length; d++) { const c = layer.cells[i][d]; if (c && c.t > 0) hit++; }
          return hit;
        };
        return cov(b) - cov(a);
      });
    } else if (sort === "activity") {
      idxs.sort((a, b) => {
        const last = (i: number) => {
          const layer = isSilver ? silver : voyage;
          for (let d = dates.length - 1; d >= (isSilver ? silverDateOffset : 0); d--) { const c = layer.cells[i][d]; if (c && c.t > 0) return d; }
          return -1;
        };
        return last(b) - last(a);
      });
    } else if (sort === "imo") {
      idxs.sort((a, b) => ships[a].imo_number.localeCompare(ships[b].imo_number, undefined, { numeric: true }));
    } else if (sort === "cruise_line") {
      idxs.sort((a, b) => ships[a].cruise_line.localeCompare(ships[b].cruise_line) || ships[a].display_name.localeCompare(ships[b].display_name));
    } else {
      idxs.sort((a, b) => ships[a].display_name.localeCompare(ships[b].display_name));
    }
    return idxs;
  }, [ships, filter, inServiceOnly, selectedLines, sort, isSilver, silverShipSet, silverDateOffset, dates, voyage, silver]);

  // KPIs — filter-aware
  const kpis = useMemo(() => {
    if (isSilver) {
      let withData = 0, needsReview = 0, missing = 0;
      for (const si of baseShipIdx) {
        for (let di = silverDateOffset; di < dates.length; di++) {
          const cell = silver.cells[si][di];
          if (!cell || cell.t === 0) { missing++; continue; }
          withData++;
          if ((cell.dt + cell.dd + cell.sp + cell.ol) > 0) needsReview++;
        }
      }
      const cleanDays = withData - needsReview;
      const totalDays = withData + missing;
      const pct = totalDays === 0 ? 0 : Math.round((cleanDays / totalDays) * 1000) / 10;
      return { ships: baseShipIdx.length, dates: silverDates.length, pct, label: "cleaned", withData, needsReview, missing };
    } else {
      let withData = 0, needsReview = 0, missing = 0;
      for (const si of baseShipIdx) {
        for (let d = 0; d < dates.length; d++) {
          const cell = voyage.cells[si][d];
          if (!cell || cell.t === 0) { missing++; continue; }
          withData++;
          const v = cell.v, na = cell.na, dw = cell.dw;
          if (Math.max(0, cell.t - v - na - dw) > 0 || na > 0 || dw > 0) needsReview++;
        }
      }
      const pct = (withData + missing) === 0 ? 0 : Math.round((withData / (withData + missing)) * 1000) / 10;
      return { ships: baseShipIdx.length, dates: dates.length, pct, label: "covered", withData, needsReview, missing };
    }
  }, [isSilver, baseShipIdx, silverDateOffset, dates, silver, voyage, silverDates]);

  const rowCount = baseShipIdx.length;
  const colCount = activeDates.length;
  const totalW = HEADER_W + colCount * CELL_W;
  const totalH = HEADER_H + rowCount * CELL_H;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let pending = 0;
    const onScroll = () => {
      scrollPosRef.current.x = el.scrollLeft;
      scrollPosRef.current.y = el.scrollTop;
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; setRenderTick(n => (n + 1) | 0); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (pending) cancelAnimationFrame(pending); };
  }, []);

  // Canvas draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const vw = viewport.w, vh = viewport.h;
    if (!vw || !vh) return;

    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width  = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sx = scrollPosRef.current.x, sy = scrollPosRef.current.y;

    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, vw, vh);

    const firstCol = Math.max(0, Math.floor(sx / CELL_W));
    const lastCol  = Math.min(colCount - 1, Math.ceil((sx + vw - HEADER_W) / CELL_W));
    const firstRow = Math.max(0, Math.floor(sy / CELL_H));
    const lastRow  = Math.min(rowCount - 1, Math.ceil((sy + vh - HEADER_H) / CELL_H));

    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, HEADER_H, vw - HEADER_W, vh - HEADER_H);
    ctx.clip();

    // Alternating row stripe
    for (let r = firstRow; r <= lastRow; r += 2) {
      ctx.fillStyle = C_PANEL;
      ctx.fillRect(HEADER_W, HEADER_H + r * CELL_H - sy, vw - HEADER_W, CELL_H);
    }

    // Cells
    for (let r = firstRow; r <= lastRow; r++) {
      const shipIdx = baseShipIdx[r];
      const y = HEADER_H + r * CELL_H - sy;
      for (let c = firstCol; c <= lastCol; c++) {
        const di = activeDateOffset + c;
        const cx = HEADER_W + c * CELL_W - sx;
        const cw = CELL_W - 1, ch = CELL_H - 1;

        if (mode === "voyage") {
          const cell = voyage.cells[shipIdx][di];
          ctx.fillStyle = cell ? (voyageCellColor(cell) ?? C_MISSING) : C_MISSING;
          ctx.fillRect(cx, y, cw, ch);
        } else if (mode === "silver") {
          const cell = silver.cells[shipIdx][di];
          ctx.fillStyle = cell ? (silverCellColor(cell) ?? C_MISSING) : C_MISSING;
          ctx.fillRect(cx, y, cw, ch);
        } else {
          const vc = voyage.cells[shipIdx][di];
          const sc = silver.cells[shipIdx][di];
          const vcol = vc ? voyageCellColor(vc) : null;
          const scol = sc ? silverCellColor(sc) : null;
          if (!vcol && !scol) { ctx.fillStyle = C_MISSING; ctx.fillRect(cx, y, cw, ch); }
          else drawDiagonalCell(ctx, cx, y, cw, ch, vcol, scol);
        }
      }
    }

    // Drag selection overlay (silver mode only)
    if (drag && mode === "silver") {
      const r0 = Math.min(drag.r0, drag.r1), r1 = Math.max(drag.r0, drag.r1);
      const c0 = Math.min(drag.c0, drag.c1), c1 = Math.max(drag.c0, drag.c1);
      const px = HEADER_W + c0 * CELL_W - sx;
      const py = HEADER_H + r0 * CELL_H - sy;
      const pw = (c1 - c0 + 1) * CELL_W;
      const ph = (r1 - r0 + 1) * CELL_H;
      ctx.fillStyle = "rgba(78,163,116,0.15)";
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = "#4ea374";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    }

    ctx.restore();

    // Top date header
    ctx.fillStyle = C_BG2;
    ctx.fillRect(HEADER_W, 0, vw - HEADER_W, HEADER_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, 0, vw - HEADER_W, HEADER_H);
    ctx.clip();
    ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "middle";
    let prevYear = "", prevMonth = "";
    for (let c = firstCol; c <= lastCol; c++) {
      const d = activeDates[c];
      const yr = d.slice(0, 4), mo = d.slice(5, 7);
      const x = HEADER_W + c * CELL_W - sx;
      if (yr !== prevYear) {
        ctx.fillStyle = C_LINE2; ctx.fillRect(x, 0, 1, HEADER_H);
        ctx.fillStyle = C_INK;   ctx.fillText(yr, x + 3, 10);
        prevYear = yr; prevMonth = "";
      }
      if (mo !== prevMonth) {
        ctx.fillStyle = C_INK_DIM; ctx.fillText(mo, x + 3, 26);
        prevMonth = mo;
      }
    }
    ctx.restore();

    // Left ship header
    ctx.fillStyle = C_BG2;
    ctx.fillRect(0, 0, HEADER_W, vh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_H, HEADER_W, vh - HEADER_H);
    ctx.clip();
    ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (let r = firstRow; r <= lastRow; r++) {
      const shipIdx = baseShipIdx[r];
      const ship = ships[shipIdx];
      const yTop = HEADER_H + r * CELL_H - sy;
      if (r % 2 === 0) { ctx.fillStyle = C_PANEL; ctx.fillRect(0, yTop, HEADER_W, CELL_H); }
      ctx.fillStyle = ship.in_service ? C_INK : C_INK_FAINT;
      ctx.fillText(ship.display_name.slice(0, 26), 10, yTop + CELL_H / 2);
    }
    ctx.restore();

    // Corner + border lines (0.5px, subtle)
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, HEADER_W, HEADER_H);
    ctx.fillStyle = C_LINE2;
    ctx.fillRect(0, HEADER_H - 1, vw, 1);
    ctx.fillRect(HEADER_W - 1, 0, 1, vh);
  });

  // ---------- hit test helpers ----------
  const hitTest = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    if (cx < HEADER_W || cy < HEADER_H) return null;
    const sx = scrollPosRef.current.x, sy = scrollPosRef.current.y;
    const c = Math.floor((cx - HEADER_W + sx) / CELL_W);
    const r = Math.floor((cy - HEADER_H + sy) / CELL_H);
    if (c < 0 || c >= colCount || r < 0 || r >= rowCount) return null;
    return { r, c, shipIdx: baseShipIdx[r], dateIdx: activeDateOffset + c };
  }, [colCount, rowCount, baseShipIdx, activeDateOffset]);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "silver") return;
    const hit = hitTest(e);
    if (!hit) return;
    isDragging.current = true;
    setDrag({ r0: hit.r, c0: hit.c, r1: hit.r, c1: hit.c });
  }, [mode, hitTest]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitTest(e);
    if (!hit) { setTooltip(null); return; }
    const ship = ships[hit.shipIdx];
    const date = dates[hit.dateIdx];
    const v = payload.voyage_cells[String(ship.mmsi)]?.[date];
    const s = payload.silver_cells[String(ship.mmsi)]?.[date];
    setTooltip({ x: e.clientX, y: e.clientY, ship, date, voyage: v, silver: s });
    if (isDragging.current && mode === "silver") {
      setDrag(prev => prev ? { ...prev, r1: hit.r, c1: hit.c } : prev);
      setRenderTick(n => (n + 1) | 0);
    }
  }, [hitTest, ships, dates, payload, mode]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current || !drag || mode !== "silver") { isDragging.current = false; return; }
    isDragging.current = false;
    const r0 = Math.min(drag.r0, drag.r1), r1 = Math.max(drag.r0, drag.r1);
    const c0 = Math.min(drag.c0, drag.c1), c1 = Math.max(drag.c0, drag.c1);
    // Only open modal if more than a single accidental click (allow single-cell)
    const shipIdx = baseShipIdx[r0];
    const ship = ships[shipIdx];
    // For multi-ship drags, just use first ship (row-based assignment)
    const dateStart = activeDates[c0];
    const dateEnd   = activeDates[c1];
    if (dateStart && dateEnd) {
      setAssignModal({ ship, dateStart, dateEnd });
    }
    setDrag(null);
    void e;
  }, [drag, mode, baseShipIdx, ships, activeDates]);

  const onMouseLeave = useCallback(() => {
    setTooltip(null);
    if (isDragging.current) { isDragging.current = false; setDrag(null); }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", background: C_BG, color: C_INK }}>

      {/* KPI bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 28, padding: "10px 36px", background: C_BG2, borderBottom: `1px solid ${C_LINE}`, flexShrink: 0, flexWrap: "wrap" }}>
        <KpiStat value={String(kpis.ships)} label="ships" />
        <KpiDivider />
        <KpiStat value={kpis.withData.toLocaleString()} label="days with data" color={C_VISIBLE} />
        <KpiStat value={kpis.needsReview.toLocaleString()} label="needs review" color={kpis.needsReview > 0 ? C_DW : C_INK_FAINT} />
        <KpiStat value={kpis.missing.toLocaleString()} label={isSilver ? "no data" : "no voyage"} color={C_INK_FAINT} />
        <KpiDivider />
        <KpiStat value={`${kpis.pct}%`} label={kpis.label} color={kpis.pct > 50 ? C_VISIBLE : C_DW} />
        <div style={{ marginLeft: "auto" }}><Legend mode={mode} /></div>
      </div>

      {/* Controls bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 36px", background: C_BG2, borderBottom: `1px solid ${C_LINE}`, flexShrink: 0, flexWrap: "wrap" }}>
        <CtrlLabel>Sort</CtrlLabel>
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)} style={selectStyle}>
          {SORT_OPTIONS.map(({ k, label }) => <option key={k} value={k}>{label}</option>)}
        </select>

        <Divider />

        {/* Cruise line multi-select dropdown */}
        <CtrlLabel>Line</CtrlLabel>
        <CruiseLineDropdown
          options={cruiseLineList}
          selected={selectedLines}
          onToggle={toggleLine}
          onClear={() => setSelectedLines(new Set())}
        />

        <Divider />

        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="filter ships…"
          style={{ padding: "4px 8px", background: C_BG, border: `1px solid ${C_LINE}`, borderRadius: 2, fontSize: 11, color: C_INK, fontFamily: "inherit", width: 150, outline: "none" }}
        />

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: C_INK_DIM, cursor: "pointer", userSelect: "none", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          <input type="checkbox" checked={inServiceOnly} onChange={e => setInServiceOnly(e.target.checked)} style={{ accentColor: C_VISIBLE }} />
          In service
        </label>

        <Divider />

        <CtrlLabel>Density</CtrlLabel>
        <div style={{ display: "flex", borderRadius: 2, border: `1px solid ${C_LINE}`, overflow: "hidden" }}>
          {DENSITY_OPTIONS.map(({ k, label }) => (
            <button
              key={k}
              onClick={() => setDensity(k)}
              style={{
                padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit",
                background: density === k ? C_VISIBLE : "transparent",
                color: density === k ? "#0b1014" : C_INK_FAINT,
                border: "none", borderRight: k !== "roomy" ? `1px solid ${C_LINE}` : "none",
                fontWeight: density === k ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "silver" && (
          <span style={{ fontSize: 9.5, color: C_VISIBLE, letterSpacing: "0.04em" }}>
            ↖ drag to select cells for assignment
          </span>
        )}

        <div style={{ marginLeft: "auto", fontSize: 10, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums" }}>
          {isSilver ? (silverDates[0] ?? "") : payload.date_range.start} → {payload.date_range.end}
        </div>
      </div>

      {/* Grid */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          ref={scrollRef}
          style={{ position: "relative", flex: 1, overflow: "auto", contain: "strict" } as React.CSSProperties}
          onMouseLeave={onMouseLeave}
        >
          <div style={{ width: totalW, height: totalH, position: "relative" }}>
            <canvas
              ref={canvasRef}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              style={{ position: "sticky", top: 0, left: 0, width: viewport.w, height: viewport.h, display: "block", cursor: mode === "silver" ? "crosshair" : "default", userSelect: "none" }}
            />
          </div>
        </div>
      </div>

      {tooltip && <HoverTooltip tooltip={tooltip} mode={mode} />}

      {assignModal && (
        <AssignModal
          ship={assignModal.ship}
          dateStart={assignModal.dateStart}
          dateEnd={assignModal.dateEnd}
          onConfirm={async (assignee, notes) => {
            const id = crypto.randomUUID();
            const draft = {
              id,
              ship_mmsi: assignModal.ship.mmsi,
              ship_name: assignModal.ship.display_name,
              cruise_line: assignModal.ship.cruise_line,
              date_start: assignModal.dateStart,
              date_end: assignModal.dateEnd,
              created_at: new Date().toISOString(),
            };
            addDraft(draft);
            setAssignModal(null);
            fetch("/api/sheets/assignments", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ assignment_id: id, ...draft, assignee, notes }),
            }).then(r => r.json()).then(r => {
              if (!r.ok) console.error("[assign] Sheets write failed:", r.error);
              else console.log("[assign] Sheets row appended:", id);
            }).catch(e => console.error("[assign] fetch error:", e));
          }}
          onClose={() => setAssignModal(null)}
        />
      )}
    </div>
  );
}

// ---- sub-components ----

function KpiStat({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 26, letterSpacing: "-0.02em", color: color ?? C_INK, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function KpiDivider() {
  return <div style={{ width: 1, height: 28, background: C_LINE, flexShrink: 0 }} />;
}

function CtrlLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT, whiteSpace: "nowrap" }}>{children}</span>;
}

function CruiseLineDropdown({ options, selected, onToggle, onClear }: {
  options: string[];
  selected: Set<string>;
  onToggle: (cl: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = selected.size;
  const label = count === 0 ? "All lines" : count === 1 ? Array.from(selected)[0] : `${count} lines`;

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "3px 8px", fontSize: 11, cursor: "pointer",
          background: count > 0 ? `${C_VISIBLE}18` : C_BG,
          border: `1px solid ${count > 0 ? C_VISIBLE : C_LINE}`,
          borderRadius: 2, color: count > 0 ? C_VISIBLE : C_INK,
          fontFamily: "inherit", outline: "none", minWidth: 110,
        }}
      >
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontSize: 8, color: C_INK_FAINT, flexShrink: 0 }}>▼</span>
      </button>

      {open && (
        <>
          {/* backdrop */}
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50,
            background: C_PANEL, border: `1px solid ${C_LINE}`,
            borderRadius: 3, minWidth: 200, maxHeight: 280, overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}>
            {count > 0 && (
              <button
                onClick={() => { onClear(); setOpen(false); }}
                style={{ width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 10, color: C_INK_FAINT, background: "none", border: "none", borderBottom: `1px solid ${C_LINE}`, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.06em", textTransform: "uppercase" }}
              >
                Clear selection
              </button>
            )}
            {options.map(cl => {
              const on = selected.has(cl);
              return (
                <div
                  key={cl}
                  onClick={() => onToggle(cl)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "7px 12px", cursor: "pointer", fontSize: 11,
                    color: on ? C_VISIBLE : C_INK,
                    background: on ? `${C_VISIBLE}14` : "transparent",
                    borderBottom: `1px solid ${C_LINE}`,
                    transition: "background 0.08s",
                  }}
                  onMouseEnter={e => { if (!on) (e.currentTarget as HTMLElement).style.background = `${C_PANEL}cc`; }}
                  onMouseLeave={e => { if (!on) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  {/* checkbox indicator */}
                  <span style={{
                    width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                    border: `1px solid ${on ? C_VISIBLE : C_LINE}`,
                    background: on ? C_VISIBLE : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {on && <span style={{ fontSize: 8, color: "#0b1014", lineHeight: 1 }}>✓</span>}
                  </span>
                  {cl}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 16, background: C_LINE, flexShrink: 0 }} />;
}

const selectStyle: React.CSSProperties = {
  padding: "3px 8px", background: C_BG, border: `1px solid ${C_LINE}`,
  borderRadius: 2, fontSize: 11, color: C_INK, fontFamily: "inherit", outline: "none", cursor: "pointer",
};

function Legend({ mode }: { mode: ShellMode }) {
  const entries = mode === "silver"
    ? [{ color: C_SILVER_OK, label: "Clean" }, { color: C_SILVER_NR, label: "Needs review" }, { color: C_MISSING, label: "No data", border: true }]
    : mode === "voyage"
      ? [{ color: C_VISIBLE, label: "Visible" }, { color: C_DW, label: "Details wrong" }, { color: C_NO_AIS, label: "No AIS" }, { color: C_NEED_PROC, label: "Need process" }, { color: C_MISSING, label: "No voyage", border: true }]
      : [{ color: C_VISIBLE, label: "Voyage visible" }, { color: C_SILVER_OK, label: "Silver clean" }, { color: C_SILVER_NR, label: "Silver review" }, { color: C_MISSING, label: "No data", border: true }];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {entries.map(e => (
        <div key={e.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: e.color, border: (e as {border?: boolean}).border ? `1px solid ${C_LINE}` : undefined }} />
          <span style={{ fontSize: 9.5, color: C_INK_FAINT }}>{e.label}</span>
        </div>
      ))}
    </div>
  );
}

function HoverTooltip({ tooltip, mode }: { tooltip: NonNullable<TooltipState>; mode: ShellMode }) {
  const { x, y, ship, date, voyage, silver } = tooltip;
  return (
    <div style={{
      position: "fixed", zIndex: 50, pointerEvents: "none",
      background: C_PANEL, border: `1px solid ${C_LINE}`,
      borderRadius: 4, padding: "10px 14px", fontSize: 11, color: C_INK,
      boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
      left: x + 14, top: y - 8,
      transform: x > window.innerWidth - 260 ? "translateX(-110%)" : undefined,
    }}>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>{ship.display_name}</div>
        <div style={{ fontSize: 9.5, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
          IMO {ship.imo_number} · MMSI {ship.mmsi}
        </div>
        <div style={{ fontSize: 10, color: C_INK_DIM, marginTop: 2 }}>{date}</div>
      </div>
      {(mode === "voyage" || mode === "combined") && voyage && <VoyageTooltip cell={voyage} />}
      {(mode === "silver" || mode === "combined") && silver && <SilverTooltip cell={silver} />}
      {!voyage && !silver && <div style={{ color: C_INK_FAINT }}>no data</div>}
    </div>
  );
}

function VoyageTooltip({ cell }: { cell: Cell }) {
  const { t, v, na, dw } = cell;
  const np = Math.max(0, t - v - na - dw);
  return (
    <div style={{ borderTop: `1px solid ${C_LINE}`, paddingTop: 5, marginTop: 4 }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT, marginBottom: 3 }}>Voyage</div>
      {[["Total", t, undefined], ["Visible", v, C_VISIBLE], ["Details wrong", dw, C_DW], ["No AIS", na, C_NO_AIS], ["Need process", np, C_NEED_PROC]] .map(([l, val, col]) => (
        <div key={String(l)} style={{ display: "flex", justifyContent: "space-between", gap: 14, marginBottom: 1 }}>
          <span style={{ color: C_INK_DIM }}>{l}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: (col as string | undefined) ?? C_INK, fontWeight: col ? 600 : 400 }}>{val as number}</span>
        </div>
      ))}
    </div>
  );
}

function SilverTooltip({ cell }: { cell: Cell }) {
  const clean = (cell.dt + cell.dd + cell.sp + cell.ol) === 0;
  return (
    <div style={{ borderTop: `1px solid ${C_LINE}`, paddingTop: 5, marginTop: 4 }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT, marginBottom: 3 }}>Silver</div>
      {[["Rows", cell.t], ["Delta time", cell.dt], ["Delta dist", cell.dd], ["Spikes", cell.sp], ["Overland", cell.ol]].map(([l, val]) => (
        <div key={String(l)} style={{ display: "flex", justifyContent: "space-between", gap: 14, marginBottom: 1 }}>
          <span style={{ color: C_INK_DIM }}>{l}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: (val as number) > 0 && l !== "Rows" ? C_SILVER_NR : C_INK }}>{val as number}</span>
        </div>
      ))}
      <div style={{ marginTop: 4, fontSize: 10, color: clean ? C_SILVER_OK : C_SILVER_NR, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>{clean ? "Clean" : "Needs review"}</div>
    </div>
  );
}

const ASSIGNABLE_MEMBERS = [
  { slug: "bea",     display_name: "Bea" },
  { slug: "ronnel",  display_name: "Ronnel" },
  { slug: "kaye",    display_name: "Kaye" },
  { slug: "coleen",  display_name: "Coleen" },
  { slug: "kim",     display_name: "Kim" },
  { slug: "nick",    display_name: "Nick" },
  { slug: "nicole",  display_name: "Nicole" },
  { slug: "jayziel", display_name: "Jayziel" },
  { slug: "ai-ai",   display_name: "Ai-ai" },
  { slug: "rome",    display_name: "Rome" },
  { slug: "dave",    display_name: "Dave" },
  { slug: "jen",     display_name: "Jen" },
  { slug: "jovi",    display_name: "Jovi" },
];

function AssignModal({ ship, dateStart, dateEnd, onConfirm, onClose }: {
  ship: Ship; dateStart: string; dateEnd: string;
  onConfirm: (assignee: string, notes: string) => Promise<void>;
  onClose: () => void;
}) {
  const [assignee, setAssignee] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: C_PANEL, border: `1px solid ${C_LINE}`, borderRadius: 6, padding: "28px 32px", width: 420, display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", color: "var(--accent)", marginBottom: 8 }}>New Assignment</div>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 20, color: C_INK }}>{ship.display_name}</div>
          <div style={{ fontSize: 10, color: C_INK_FAINT, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{dateStart} → {dateEnd}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT }}>Assignee</label>
          <select
            value={assignee}
            onChange={e => setAssignee(e.target.value)}
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
          >
            <option value="" disabled>Select team member…</option>
            {ASSIGNABLE_MEMBERS.map(m => (
              <option key={m.slug} value={m.slug}>{m.display_name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT }}>Notes</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional" style={{ ...inputStyle }} />
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ ...btnStyle, background: "transparent", color: C_INK_FAINT, border: `1px solid ${C_LINE}` }}>Cancel</button>
          <button
            onClick={async () => {
              if (!assignee || submitting) return;
              setSubmitting(true);
              await onConfirm(assignee, notes);
              setSubmitting(false);
            }}
            disabled={!assignee || submitting}
            style={{ ...btnStyle, background: assignee && !submitting ? "var(--accent)" : C_LINE, color: assignee && !submitting ? "#1a1207" : C_INK_FAINT, border: "none", fontWeight: 600 }}
          >
            {submitting ? "Saving…" : "Add to Queue"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = { padding: "7px 10px", background: C_BG, border: `1px solid ${C_LINE}`, borderRadius: 3, fontSize: 12, color: C_INK, fontFamily: "inherit", outline: "none", width: "100%" };
const btnStyle: React.CSSProperties = { padding: "7px 18px", borderRadius: 3, fontSize: 11, fontFamily: "inherit", cursor: "pointer" };
