"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import type { Cell, CoveragePayload, Ship } from "./types";
import type { ShellMode } from "./CoverageShell";
import { useAssignments } from "./AssignmentContext";

// Cleaners who work live-data — highlighted in the assignee picker
const LIVE_DATA_TEAM = new Set(["nick", "ai-ai", "kim"]);

// Client-safe db_user_id → display_name lookup (mirrors lib/sheets/team-config.ts,
// can't import that here because it has "server-only").
const USER_ID_TO_NAME: Record<string, string> = {
  "8": "Angus", "10": "Mon", "11": "Bea", "12": "Ronnel", "13": "Kaye",
  "16": "Coleen", "17": "Kim", "19": "Nick", "21": "Nicole", "22": "Jayziel",
  "23": "Ai-ai", "26": "Rome", "28": "Rich", "29": "Dave", "31": "Jen", "37": "Jovi",
};

// Distinct colour per live-data cleaner so the dot signals who owns it at a glance.
// Other cleaners share a neutral amber dot.
const ASSIGNEE_COLOR: Record<string, string> = {
  "nick":  "#7ad6a8", // green
  "kim":   "#e8c170", // yellow
  "ai-ai": "#5fa8f7", // blue
};
const ASSIGNEE_COLOR_DEFAULT = "#e8c170"; // amber

// Border colour for silver cells where the underlying silver row was last
// touched by a human (not data-platform).
const C_UPDATED = "#5fa8f7";

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
type VoyageCellStyle = { fill: string; border: string | null };

function voyageCellStyle(cell: Cell): VoyageCellStyle | null {
  const { t, v, na, dw } = cell;
  if (t === 0) return null;
  const need_process = Math.max(0, t - v - na - dw);
  const max = Math.max(v, dw, na, need_process);
  if (max === 0) return null;

  if (v >= 1) {
    // Green fill. Border = dominant problem colour, if any problems exist.
    const problemMax = Math.max(dw, na, need_process);
    let border: string | null = null;
    if (problemMax > 0) {
      if (dw >= problemMax)          border = C_DW;
      else if (na >= problemMax)     border = C_NO_AIS;
      else                           border = C_NEED_PROC;
    }
    return { fill: C_VISIBLE, border };
  }

  // No visible voyages — solid fill by dominant problem
  if (dw >= Math.max(na, need_process)) return { fill: C_DW,        border: null };
  if (na >= need_process)               return { fill: C_NO_AIS,    border: null };
  if (need_process > 0)                 return { fill: C_NEED_PROC, border: null };
  return null;
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

// True if `date` falls outside the ship's [service_start, service_end] window.
// Blank service_start = "active before voyage window"; blank service_end =
// "still in service". String comparison is safe because dates are YYYY-MM-DD.
function isOutOfService(ship: Ship, date: string): boolean {
  if (ship.service_start && date < ship.service_start) return true;
  if (ship.service_end   && date > ship.service_end)   return true;
  return false;
}

// Out-of-service cells render as solid dark grey with a diagonal hatch on top.
// Visually distinct from C_MISSING (the BG colour used for "no data") so the
// viewer can tell "this ship wasn't active yet" from "no request on this day".
const C_OUT_OF_SERVICE = "#1a232b";
const C_OUT_OF_SERVICE_HATCH = "rgba(90,109,124,0.35)";
function drawOutOfServiceCell(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = C_OUT_OF_SERVICE;
  ctx.fillRect(x, y, w, h);
  // Diagonal hatch — short strokes every 4px from top-right to bottom-left.
  // Cheap to draw per-cell since w/h are small (5–11px) and we only run this
  // for cells inside the visible viewport.
  ctx.save();
  ctx.strokeStyle = C_OUT_OF_SERVICE_HATCH;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 4;
  for (let off = -h; off < w; off += step) {
    ctx.moveTo(x + off, y);
    ctx.lineTo(x + off + h, y + h);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------- types ----------
type SortKey = "name" | "coverage" | "activity" | "imo" | "cruise_line";

type AssignmentInfo = { assignee: string; status: string; id: string; notes?: string; dateStart: string; dateEnd: string };
type TooltipState = { x: number; y: number; ship: Ship; date: string; voyage?: Cell; silver?: Cell; assignment?: AssignmentInfo } | null;

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
  const { addDraft, drafts: assignments, reload: reloadAssignments } = useAssignments();
  const { data: session } = useSession();
  const isAssigner = session?.user?.role === "assigner";

  const scrollRef    = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const scrollPosRef = useRef({ x: 0, y: 0 });
  const isDragging   = useRef(false);

  const [viewport,    setViewport]    = useState({ w: 0, h: 0 });
  const [,            setRenderTick]  = useState(0);
  const [filter,      setFilter]      = useState("");
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set());
  const [selectedTiers, setSelectedTiers] = useState<Set<1 | 2 | 3 | 4>>(new Set());
  const [inServiceOnly, setInServiceOnly] = useState(false);
  const [sort,        setSort]        = useState<SortKey>("name");
  const [tooltip,     setTooltip]     = useState<TooltipState>(null);
  const [drag,        setDrag]        = useState<DragState>(null);
  const [assignModal, setAssignModal] = useState<{ ship: Ship; dateStart: string; dateEnd: string } | null>(null);
  const [editModal, setEditModal] = useState<{ assignment: AssignmentInfo; ship: Ship; dateStart: string; dateEnd: string } | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string>(""); // "" = all
  const [density, setDensity] = useState<Density>("default");

  const { w: CELL_W, h: CELL_H } = DENSITY_SIZES[density];

  const isSilver = mode === "silver";
  const activeDates      = isSilver ? silverDates : dates;
  const activeDateOffset = isSilver ? silverDateOffset : 0;

  // Map "mmsi|YYYY-MM-DD" → { assignee, status } for every ship-day covered
  // by an active (non-done) assignment. Used for dot rendering and tooltips.
  // Clamp iteration to the silver date window to avoid expanding bulk
  // month-range assignments into hundreds of thousands of map entries.
  const assignedCells = useMemo(() => {
    const map = new Map<string, AssignmentInfo>();
    const windowStart = new Date(silverDates[0] + "T00:00:00Z");
    const windowEnd   = new Date(silverDates[silverDates.length - 1] + "T00:00:00Z");
    for (const a of assignments) {
      if (!a.ship_mmsi || !a.date_start || !a.date_end) continue;
      const status = a.status ?? "queued";
      if (status === "done") continue;
      const assignee = a.assignee ?? "";
      // Parse as UTC midnight to avoid DST shifts (e.g. Oct 31 / Mar 31 in GMT+1)
      const rawStart = new Date(a.date_start + "T00:00:00Z");
      const rawEnd   = new Date(a.date_end   + "T00:00:00Z");
      // Clamp to the visible silver window
      const start = rawStart < windowStart ? windowStart : rawStart;
      const end   = rawEnd   > windowEnd   ? windowEnd   : rawEnd;
      if (start > end) continue;
      for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        map.set(`${a.ship_mmsi}|${d.toISOString().slice(0, 10)}`, { assignee, status, id: a.id, notes: a.notes, dateStart: a.date_start, dateEnd: a.date_end });
      }
    }
    return map;
  }, [assignments, silverDates]);

  // Toggle a cruise line in/out of the multi-select set
  const toggleLine = useCallback((cl: string) => {
    setSelectedLines(prev => {
      const next = new Set(prev);
      if (next.has(cl)) next.delete(cl); else next.add(cl);
      return next;
    });
  }, []);

  // Set of mmsis that have at least one assigned day for the active assignee filter
  const filteredAssigneeMmsis = useMemo(() => {
    if (!assigneeFilter) return null;
    const mmsis = new Set<number>();
    for (const a of assignments) {
      if ((a.assignee ?? "") === assigneeFilter && a.status !== "done" && a.ship_mmsi) {
        mmsis.add(a.ship_mmsi);
      }
    }
    return mmsis;
  }, [assigneeFilter, assignments]);

  // Filtered + sorted ship index list
  const baseShipIdx = useMemo(() => {
    let idxs = ships.map((_, i) => i).filter(i => {
      const s = ships[i];
      if (isSilver && !silverShipSet.has(s.mmsi)) return false;
      if (inServiceOnly && !s.in_service) return false;
      if (selectedTiers.size > 0 && !selectedTiers.has(s.tier)) return false;
      if (selectedLines.size > 0 && !selectedLines.has(s.cruise_line)) return false;
      if (filteredAssigneeMmsis && !filteredAssigneeMmsis.has(s.mmsi)) return false;
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
  }, [ships, filter, inServiceOnly, selectedLines, selectedTiers, filteredAssigneeMmsis, sort, isSilver, silverShipSet, silverDateOffset, dates, voyage, silver]);

  // KPIs — filter-aware
  const kpis = useMemo(() => {
    if (isSilver) {
      let withData = 0, needsReview = 0, missing = 0;
      for (const si of baseShipIdx) {
        const ship = ships[si];
        for (let di = silverDateOffset; di < dates.length; di++) {
          if (isOutOfService(ship, dates[di])) continue;
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
      // COVID window: days in this range with no legit coverage are excluded from denominator
      const COVID_START = "2020-03-01";
      const COVID_END   = "2021-11-30";
      const covidStartIdx = dates.findIndex(d => d >= COVID_START);
      const covidEndIdx   = (() => { let i = dates.length - 1; while (i >= 0 && dates[i] > COVID_END) i--; return i; })();
      const covidWindowLen = (covidStartIdx >= 0 && covidEndIdx >= covidStartIdx) ? covidEndIdx - covidStartIdx + 1 : 0;

      // Returns the set of date indices (within COVID window) that are part of a qualifying
      // contiguous run: ≥10 consecutive v>=1 days, anchored within 7 days of either boundary.
      function qualifyingCovidIndices(si: number): Set<number> {
        const qualifying = new Set<number>();
        if (covidWindowLen <= 0) return qualifying;
        // Find all contiguous runs of v>=1 within the COVID window
        let runStart = -1;
        const flush = (runEnd: number) => {
          if (runStart < 0) return;
          const len = runEnd - runStart + 1;
          const anchored =
            (runStart - covidStartIdx) <= 7 ||
            (covidEndIdx - runEnd)     <= 7;
          if (len >= 10 && anchored) {
            for (let i = runStart; i <= runEnd; i++) qualifying.add(i);
          }
          runStart = -1;
        };
        for (let d = covidStartIdx; d <= covidEndIdx; d++) {
          const cell = voyage.cells[si][d];
          if (cell && cell.v >= 1) {
            if (runStart < 0) runStart = d;
          } else {
            flush(d - 1);
          }
        }
        flush(covidEndIdx);
        return qualifying;
      }

      let withData = 0, requested = 0, needsReview = 0, missing = 0, covidExcluded = 0, oosExcluded = 0;
      for (const si of baseShipIdx) {
        const ship = ships[si];
        const qualifiedCovidIdx = covidWindowLen > 0 ? qualifyingCovidIndices(si) : null;
        for (let d = 0; d < dates.length; d++) {
          // Skip days outside the ship's [service_start, service_end] window —
          // a ship retired in 2020 shouldn't drag down the 2015–today denominator.
          if (isOutOfService(ship, dates[d])) { oosExcluded++; continue; }
          const cell = voyage.cells[si][d];
          const hasVoyage = cell && cell.t > 0;
          const hasVisible = cell && cell.v >= 1;
          // Check if this day falls in COVID window and is not a qualifying run day
          const inCovid = covidWindowLen > 0 && d >= covidStartIdx && d <= covidEndIdx;
          const covidExclude = inCovid && !hasVisible && !(qualifiedCovidIdx?.has(d));
          if (covidExclude) { covidExcluded++; continue; }
          if (!hasVisible) { missing++; } else { withData++; }
          if (hasVoyage) { requested++; }
          if (hasVisible && (cell.dw > cell.v || cell.na > cell.v)) needsReview++;
        }
      }
      const total = withData + missing;
      const pct        = total     === 0 ? 0 : Math.round((withData / total)     * 1000) / 10;
      const requestPct = requested === 0 ? 0 : Math.round((withData / requested) * 1000) / 10;
      return { ships: baseShipIdx.length, dates: dates.length, pct, requestPct, label: "covered", withData, needsReview, missing, requested, covidExcluded, oosExcluded };
    }
  }, [isSilver, baseShipIdx, silverDateOffset, dates, silver, voyage, silverDates, ships]);

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
      const ship = ships[shipIdx];
      const y = HEADER_H + r * CELL_H - sy;
      for (let c = firstCol; c <= lastCol; c++) {
        const di = activeDateOffset + c;
        const cx = HEADER_W + c * CELL_W - sx;
        const cw = CELL_W - 1, ch = CELL_H - 1;
        const cellDate = dates[di];

        // Out-of-service days short-circuit all mode-specific rendering.
        // Distinct from C_MISSING (no data) and from gap days (np=1).
        if (cellDate && isOutOfService(ship, cellDate)) {
          drawOutOfServiceCell(ctx, cx, y, cw, ch);
          continue;
        }

        if (mode === "voyage") {
          const cell = voyage.cells[shipIdx][di];
          const style = cell ? voyageCellStyle(cell) : null;
          ctx.fillStyle = style ? style.fill : C_MISSING;
          ctx.fillRect(cx, y, cw, ch);
          if (style?.border) {
            ctx.strokeStyle = style.border;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx + 0.5, y + 0.5, cw - 1, ch - 1);
          }
        } else if (mode === "silver") {
          const cell = silver.cells[shipIdx][di];
          ctx.fillStyle = cell ? (silverCellColor(cell) ?? C_MISSING) : C_MISSING;
          ctx.fillRect(cx, y, cw, ch);
          // Human-touched silver row — blue 1px outline
          if (cell && cell.u === 1) {
            ctx.strokeStyle = C_UPDATED;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx + 0.5, y + 0.5, cw - 1, ch - 1);
          }
          // Assignment dot — top-right corner, coloured by assignee
          const info = assignedCells.get(`${ships[shipIdx].mmsi}|${dates[di]}`);
          const dotVisible = info && (!assigneeFilter || info.assignee === assigneeFilter);
          if (dotVisible) {
            const r = Math.max(1.5, Math.min(2.5, CELL_W / 5));
            ctx.fillStyle = ASSIGNEE_COLOR[info.assignee] ?? ASSIGNEE_COLOR_DEFAULT;
            ctx.beginPath();
            ctx.arc(cx + cw - r - 1, y + r + 1, r, 0, Math.PI * 2);
            ctx.fill();
          }
          // Dim cells that don't match the active assignee filter
          if (assigneeFilter && !dotVisible) {
            ctx.fillStyle = "rgba(11,16,20,0.55)";
            ctx.fillRect(cx, y, cw, ch);
          }
        } else {
          const vc = voyage.cells[shipIdx][di];
          const sc = silver.cells[shipIdx][di];
          const vcol = vc ? (voyageCellStyle(vc)?.fill ?? null) : null;
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
  }, [colCount, rowCount, baseShipIdx, activeDateOffset, CELL_W, CELL_H]);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "silver") return;
    const hit = hitTest(e);
    if (!hit) return;
    // All users can click to view/edit assigned cells; drag-to-select is assigner-only
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
    const assignment = assignedCells.get(`${ship.mmsi}|${date}`);
    setTooltip({ x: e.clientX, y: e.clientY, ship, date, voyage: v, silver: s, assignment });
    if (isDragging.current && mode === "silver") {
      setDrag(prev => prev ? { ...prev, r1: hit.r, c1: hit.c } : prev);
      setRenderTick(n => (n + 1) | 0);
    }
  }, [hitTest, ships, dates, payload, mode, assignedCells]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current || !drag || mode !== "silver") { isDragging.current = false; return; }
    isDragging.current = false;
    const r0 = Math.min(drag.r0, drag.r1), r1 = Math.max(drag.r0, drag.r1);
    const c0 = Math.min(drag.c0, drag.c1), c1 = Math.max(drag.c0, drag.c1);
    const shipIdx = baseShipIdx[r0];
    const ship = ships[shipIdx];
    const dateStart = activeDates[c0];
    const dateEnd   = activeDates[c1];
    if (dateStart && dateEnd) {
      // Single-cell click on an assigned day — open edit modal only when the
      // existing assignment exactly matches this cell's date (i.e. a targeted
      // assignment). Bulk month-range rows covering this date should not block
      // creating a new targeted assignment on top.
      const isSingleCell = drag.r0 === drag.r1 && drag.c0 === drag.c1;
      const existing = isSingleCell ? assignedCells.get(`${ship.mmsi}|${dateStart}`) : undefined;
      if (existing) {
        // Open edit modal using the assignment's own date range (may be a month-range bulk row)
        setEditModal({ assignment: existing, ship, dateStart: existing.dateStart, dateEnd: existing.dateEnd });
      } else if (isAssigner) {
        setAssignModal({ ship, dateStart, dateEnd });
      }
    }
    setDrag(null);
    void e;
  }, [drag, mode, isAssigner, baseShipIdx, ships, activeDates, assignedCells]);

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
        <KpiStat
          value={`${kpis.pct}%`}
          label={kpis.label}
          color={kpis.pct > 50 ? C_VISIBLE : C_DW}
          tooltip={!isSilver && (kpis.covidExcluded ?? 0) > 0
            ? `COVID adjustment: ${(kpis.covidExcluded ?? 0).toLocaleString()} ship-days in Mar 2020 – Nov 2021 excluded from the denominator. Days in that window are only counted for ships with a continuous run of ≥10 days of visible-on-globe coverage anchored to either end of the period.`
            : undefined}
        />
        {!isSilver && (
          <KpiStat
            value={`${kpis.requestPct}%`}
            label="coverage / request"
            color={(kpis.requestPct ?? 0) > 50 ? C_VISIBLE : C_DW}
          />
        )}
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

        <CtrlLabel>Tier</CtrlLabel>
        <TierPills selected={selectedTiers} onToggle={(t) => {
          setSelectedTiers(prev => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t); else next.add(t);
            return next;
          });
        }} />

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
          <>
            <Divider />
            <CtrlLabel>Assignee</CtrlLabel>
            <AssigneeFilterPills
              assigneeFilter={assigneeFilter}
              setAssigneeFilter={setAssigneeFilter}
              session={session}
            />
          </>
        )}

        {mode === "silver" && isAssigner && (
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
              assignee,
              status: "queued" as const,
              notes,
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

      {editModal && (
        <EditAssignmentModal
          assignment={editModal.assignment}
          ship={editModal.ship}
          dateStart={editModal.dateStart}
          dateEnd={editModal.dateEnd}
          isAssigner={isAssigner}
          currentSlug={session?.user?.slug ?? ""}
          onSave={async (status, notes) => {
            const id = editModal.assignment.id;
            setEditModal(null);
            fetch(`/api/sheets/assignments/${id}`, {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status, notes }),
            }).then(r => r.json()).then(r => {
              if (!r.ok) console.error("[edit-assign] PATCH failed:", r.error);
              else reloadAssignments();
            }).catch(e => console.error("[edit-assign] fetch error:", e));
          }}
          onClose={() => setEditModal(null)}
        />
      )}
    </div>
  );
}

// ---- sub-components ----

function KpiStat({ value, label, color, tooltip }: { value: string; label: string; color?: string; tooltip?: string }) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <div style={{ position: "relative" }}>
      <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 26, letterSpacing: "-0.02em", color: color ?? C_INK, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", color: C_INK_FAINT, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {tooltip && (
          <span
            onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setTip({ x: r.left + r.width / 2, y: r.top }); }}
            onMouseLeave={() => setTip(null)}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 12, height: 12, borderRadius: "50%", border: `1px solid ${C_INK_FAINT}`, fontSize: 8, color: C_INK_FAINT, cursor: "default", flexShrink: 0, lineHeight: 1 }}
          >i</span>
        )}
      </div>
      {tip && tooltip && (
        <div style={{
          position: "fixed", left: tip.x, top: tip.y - 8,
          transform: "translate(-50%, -100%)", zIndex: 60,
          background: C_PANEL, border: `1px solid ${C_LINE}`,
          borderRadius: 4, padding: "10px 14px", fontSize: 11, color: C_INK,
          pointerEvents: "none", boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          maxWidth: 320, lineHeight: 1.55,
        }}>
          {tooltip}
        </div>
      )}
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

// Tier filter pills. T1 = mainstream contemporary; T2 = luxury + premium
// expedition; T3 = smaller regional / mid-tier; T4 = niche / single-ship
// operators (the default bucket for unmapped lines).
const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "T1",
  2: "T2",
  3: "T3",
  4: "T4",
};
function TierPills({ selected, onToggle }: { selected: Set<1 | 2 | 3 | 4>; onToggle: (t: 1 | 2 | 3 | 4) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {([1, 2, 3, 4] as const).map(t => {
        const on = selected.has(t);
        return (
          <button
            key={t}
            onClick={() => onToggle(t)}
            title={`Tier ${t}`}
            style={{
              padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit",
              background: on ? C_VISIBLE : "transparent",
              color: on ? "#0b1014" : C_INK_FAINT,
              border: `1px solid ${on ? C_VISIBLE : C_LINE}`,
              borderRadius: 2,
              fontWeight: on ? 600 : 400,
              letterSpacing: "0.04em",
            }}
          >
            {TIER_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "3px 8px", background: C_BG, border: `1px solid ${C_LINE}`,
  borderRadius: 2, fontSize: 11, color: C_INK, fontFamily: "inherit", outline: "none", cursor: "pointer",
};

function Legend({ mode }: { mode: ShellMode }) {
  const oosEntry = { color: C_OUT_OF_SERVICE, label: "Out of service", border: true };
  const entries = mode === "silver"
    ? [{ color: C_SILVER_OK, label: "Clean" }, { color: C_SILVER_NR, label: "Needs review" }, { color: C_MISSING, label: "No data", border: true }, oosEntry]
    : mode === "voyage"
      ? [
          { color: C_VISIBLE,   label: "Visible" },
          { color: C_DW,        label: "Details wrong" },
          { color: C_NO_AIS,    label: "No AIS" },
          { color: C_NEED_PROC, label: "Need process" },
          { color: C_MISSING,   label: "No voyage", border: true },
          oosEntry,
        ]
      : [{ color: C_VISIBLE, label: "Voyage visible" }, { color: C_SILVER_OK, label: "Silver clean" }, { color: C_SILVER_NR, label: "Silver review" }, { color: C_MISSING, label: "No data", border: true }, oosEntry];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {entries.map(e => {
        const { border } = e as { border?: boolean };
        return (
          <div key={e.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{
              display: "inline-block", width: 9, height: 9, borderRadius: 2,
              background: e.color,
              border: border ? `1px solid ${C_LINE}` : undefined,
            }} />
            <span style={{ fontSize: 9.5, color: C_INK_FAINT }}>{e.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function HoverTooltip({ tooltip, mode }: { tooltip: NonNullable<TooltipState>; mode: ShellMode }) {
  const { x, y, ship, date, voyage, silver, assignment } = tooltip;
  const assigneeColor = assignment
    ? (ASSIGNEE_COLOR[assignment.assignee] ?? ASSIGNEE_COLOR_DEFAULT)
    : null;
  return (
    <div style={{
      position: "fixed", zIndex: 50, pointerEvents: "none",
      background: C_PANEL, border: `1px solid ${C_LINE}`,
      borderRadius: 4, padding: "10px 14px", fontSize: 11, color: C_INK,
      boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
      left: x + 14, top: y - 8,
      transform: [
        x > window.innerWidth - 260 ? "translateX(-110%)" : "",
        y > window.innerHeight - 200 ? "translateY(-100%)" : "",
      ].filter(Boolean).join(" ") || undefined,
    }}>
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>{ship.display_name}</div>
        <div style={{ fontSize: 9.5, color: C_INK_FAINT, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
          IMO {ship.imo_number} · MMSI {ship.mmsi}
        </div>
        {(ship.cruise_type || ship.service_start || ship.service_end) && (
          <div style={{ fontSize: 9.5, color: C_INK_FAINT, marginTop: 2 }}>
            {ship.cruise_type ? `${ship.cruise_type} · ` : ""}T{ship.tier}
            {(ship.service_start || ship.service_end) ? ` · ${ship.service_start ?? "—"} → ${ship.service_end ?? "present"}` : ""}
          </div>
        )}
        <div style={{ fontSize: 10, color: C_INK_DIM, marginTop: 2 }}>{date}</div>
      </div>
      {isOutOfService(ship, date) ? (
        <div style={{ color: C_INK_FAINT, fontStyle: "italic" }}>out of service on this date</div>
      ) : (
        <>
          {(mode === "voyage" || mode === "combined") && voyage && <VoyageTooltip cell={voyage} />}
          {(mode === "silver" || mode === "combined") && silver && <SilverTooltip cell={silver} />}
          {!voyage && !silver && <div style={{ color: C_INK_FAINT }}>no data</div>}
        </>
      )}
      {/* Assignment footer — silver/cleanliness page only */}
      {(mode === "silver" || mode === "combined") && assignment && assigneeColor && (
        <div style={{ borderTop: `1px solid ${C_LINE}`, marginTop: 6, paddingTop: 5, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: assigneeColor, display: "inline-block" }} />
          <span style={{ fontSize: 9.5, color: C_INK_FAINT, textTransform: "uppercase", letterSpacing: "0.1em" }}>Assigned to</span>
          <span style={{ fontSize: 10.5, color: assigneeColor, fontWeight: 600 }}>{assignment.assignee || "—"}</span>
          <span style={{ fontSize: 9, color: C_INK_FAINT, marginLeft: "auto" }}>{assignment.status}</span>
        </div>
      )}
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
      {cell.u === 1 && (
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 1, background: C_UPDATED, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontSize: 9.5, color: C_UPDATED, letterSpacing: "0.06em" }}>
            Updated by {cell.updated_by ? (USER_ID_TO_NAME[cell.updated_by] ?? cell.updated_by) : "human"}
          </span>
        </div>
      )}
    </div>
  );
}

// All cleaners — live-data team first, then rest (client-safe, no server-only import needed)
const ASSIGNABLE_MEMBERS = [
  { slug: "nick",    display_name: "Nick" },
  { slug: "ai-ai",  display_name: "Ai-ai" },
  { slug: "kim",    display_name: "Kim" },
  { slug: "bea",    display_name: "Bea" },
  { slug: "ronnel", display_name: "Ronnel" },
  { slug: "kaye",   display_name: "Kaye" },
  { slug: "coleen", display_name: "Coleen" },
  { slug: "nicole", display_name: "Nicole" },
  { slug: "jayziel",display_name: "Jayziel" },
  { slug: "rome",   display_name: "Rome" },
  { slug: "dave",   display_name: "Dave" },
  { slug: "jen",    display_name: "Jen" },
  { slug: "jovi",   display_name: "Jovi" },
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
          <div style={{ fontSize: 10, color: C_INK_FAINT, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>MMSI {ship.mmsi} · {dateStart} → {dateEnd}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT }}>Assignee</label>
          <div style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginTop: 2 }}>Live-data team</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {ASSIGNABLE_MEMBERS.filter(m => LIVE_DATA_TEAM.has(m.slug)).map(m => {
              const col = ASSIGNEE_COLOR[m.slug] ?? ASSIGNEE_COLOR_DEFAULT;
              const selected = assignee === m.slug;
              return (
                <button
                  key={m.slug}
                  onClick={() => setAssignee(m.slug)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "5px 10px", borderRadius: 14, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 11, fontWeight: 600,
                    border: `1px solid ${selected ? col : `${col}55`}`,
                    background: selected ? `${col}22` : "transparent",
                    color: col,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: col, display: "inline-block" }} />
                  {m.display_name}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: "0.14em", color: C_INK_FAINT, marginTop: 6 }}>Other cleaners</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {ASSIGNABLE_MEMBERS.filter(m => !LIVE_DATA_TEAM.has(m.slug)).map(m => {
              const selected = assignee === m.slug;
              return (
                <button
                  key={m.slug}
                  onClick={() => setAssignee(m.slug)}
                  style={{
                    padding: "4px 9px", borderRadius: 14, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 10.5,
                    border: `1px solid ${selected ? C_INK_DIM : C_LINE}`,
                    background: selected ? C_PANEL : "transparent",
                    color: selected ? C_INK : C_INK_FAINT,
                  }}
                >
                  {m.display_name}
                </button>
              );
            })}
          </div>
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

const STATUS_OPTIONS = ["queued", "in_progress", "blocked", "done"] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];

function EditAssignmentModal({ assignment, ship, dateStart, dateEnd, isAssigner, currentSlug, onSave, onClose }: {
  assignment: AssignmentInfo;
  ship: Ship;
  dateStart: string;
  dateEnd: string;
  isAssigner: boolean;
  currentSlug: string;
  onSave: (status: string, notes: string) => Promise<void>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<StatusOption>(assignment.status as StatusOption ?? "queued");
  const [notes, setNotes]   = useState(assignment.notes ?? "");
  const [saving, setSaving] = useState(false);
  const assigneeColor = ASSIGNEE_COLOR[assignment.assignee] ?? ASSIGNEE_COLOR_DEFAULT;
  const canEdit = isAssigner || assignment.assignee === currentSlug;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: C_PANEL, border: `1px solid ${C_LINE}`, borderRadius: 6, padding: "28px 32px", width: 420, display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", color: C_INK_FAINT, marginBottom: 8 }}>Assignment</div>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 20, color: C_INK }}>{ship.display_name}</div>
          <div style={{ fontSize: 10, color: C_INK_FAINT, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>MMSI {ship.mmsi} · {dateStart} → {dateEnd}</div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: assigneeColor, display: "inline-block" }} />
            <span style={{ fontSize: 11, color: assigneeColor, fontWeight: 600 }}>{assignment.assignee || "—"}</span>
          </div>
        </div>

        {canEdit ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT }}>Status</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUS_OPTIONS.map(s => {
                  const active = status === s;
                  return (
                    <button key={s} onClick={() => setStatus(s)} style={{
                      padding: "5px 12px", borderRadius: 14, cursor: "pointer", fontFamily: "inherit",
                      fontSize: 10.5, border: `1px solid ${active ? C_VISIBLE : C_LINE}`,
                      background: active ? `${C_VISIBLE}22` : "transparent",
                      color: active ? C_VISIBLE : C_INK_FAINT, fontWeight: active ? 600 : 400,
                    }}>
                      {s.replace("_", " ")}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.12em", color: C_INK_FAINT }}>Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional" style={{ ...inputStyle }} />
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ ...btnStyle, background: "transparent", color: C_INK_FAINT, border: `1px solid ${C_LINE}` }}>Cancel</button>
              <button
                onClick={async () => { setSaving(true); await onSave(status, notes); setSaving(false); }}
                disabled={saving}
                style={{ ...btnStyle, background: saving ? C_LINE : "var(--accent)", color: saving ? C_INK_FAINT : "#1a1207", border: "none", fontWeight: 600 }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: C_INK_DIM }}>
              Status: <span style={{ color: C_INK, fontWeight: 600 }}>{assignment.status}</span>
            </div>
            {assignment.notes && <div style={{ fontSize: 11, color: C_INK_DIM }}>Notes: {assignment.notes}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ ...btnStyle, background: "transparent", color: C_INK_FAINT, border: `1px solid ${C_LINE}` }}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Assignee filter pills for the cleanliness tab controls bar.
// Cleaners see "All" + "Assigned to me" only.
// Assigners see "All" + one pill per live-data team member.
function AssigneeFilterPills({ assigneeFilter, setAssigneeFilter, session }: {
  assigneeFilter: string;
  setAssigneeFilter: (v: string) => void;
  session: ReturnType<typeof useSession>["data"];
}) {
  const isAssigner = session?.user?.role === "assigner";
  const mySlug = session?.user?.slug ?? "";

  const pills: { label: string; value: string; color?: string }[] = [
    { label: "All", value: "" },
  ];

  if (isAssigner) {
    for (const m of ASSIGNABLE_MEMBERS.filter(m => LIVE_DATA_TEAM.has(m.slug))) {
      pills.push({ label: m.display_name, value: m.slug, color: ASSIGNEE_COLOR[m.slug] });
    }
  } else if (mySlug) {
    pills.push({ label: "Assigned to me", value: mySlug, color: ASSIGNEE_COLOR[mySlug] ?? ASSIGNEE_COLOR_DEFAULT });
  }

  return (
    <div style={{ display: "flex", gap: 4 }}>
      {pills.map(p => {
        const active = assigneeFilter === p.value;
        const col = p.color ?? C_INK_DIM;
        return (
          <button
            key={p.value}
            onClick={() => setAssigneeFilter(p.value)}
            style={{
              padding: "3px 9px", borderRadius: 14, cursor: "pointer", fontFamily: "inherit",
              fontSize: 10, border: `1px solid ${active ? col : C_LINE}`,
              background: active ? `${col}22` : "transparent",
              color: active ? col : C_INK_FAINT, fontWeight: active ? 600 : 400,
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
