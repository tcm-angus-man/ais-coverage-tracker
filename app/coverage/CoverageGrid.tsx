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

const CELL_W = 8;
const CELL_H = 14;
const HEADER_H = 36;
const HEADER_W = 200;

type LayerArrays = {
  t: Uint8Array[]; // total prints (clamped 0..255)
  v: Uint8Array[]; // visible_on_globe count (clamped 0..255)
};

type Indexed = {
  payload: CoveragePayload;
  ships: Ship[];
  dates: string[];
  voyage: LayerArrays;
  silver: LayerArrays;
};

function indexPayload(payload: CoveragePayload): Indexed {
  const { ships, dates } = payload;
  const dateIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) dateIdx.set(dates[i], i);
  const clamp = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n | 0);
  const buildLayer = (
    layer: Record<string, Record<string, Cell>>,
  ): LayerArrays => {
    const t: Uint8Array[] = [];
    const v: Uint8Array[] = [];
    for (const s of ships) {
      const tArr = new Uint8Array(dates.length);
      const vArr = new Uint8Array(dates.length);
      const row = layer[String(s.mmsi)];
      if (row) {
        for (const d in row) {
          const i = dateIdx.get(d);
          if (i === undefined) continue;
          const cell = row[d];
          tArr[i] = clamp(cell.t);
          vArr[i] = clamp(cell.v);
        }
      }
      t.push(tArr);
      v.push(vArr);
    }
    return { t, v };
  };
  return {
    payload,
    ships,
    dates,
    voyage: buildLayer(payload.voyage_cells),
    silver: buildLayer(payload.silver_cells),
  };
}

type Mode = "voyage" | "silver" | "combined" | "ratio";

// rgb/alpha computed per cell
function densityAlpha(t: number): number {
  return Math.min(1, 0.2 + t / 14);
}
function ratioColor(v: number, t: number): string {
  // Hue from red (0) → amber (0.5) → green (1)
  const r = t === 0 ? 0 : v / t;
  const hue = Math.round(r * 130); // 0=red, 130=green-ish
  const a = densityAlpha(t);
  return `hsla(${hue}, 75%, 50%, ${a})`;
}

type Selection = {
  shipIdx: number;
  dateIdx: number;
  voyage?: Cell;
  silver?: Cell;
} | null;

export default function CoverageGrid({
  payload,
}: {
  payload: CoveragePayload;
}) {
  const indexed = useMemo(() => indexPayload(payload), [payload]);
  const { ships, dates, voyage, silver } = indexed;

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollPosRef = useRef({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [, setRenderTick] = useState(0);
  const [mode, setMode] = useState<Mode>("combined");
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<Selection>(null);

  const visibleShipIdx = useMemo(() => {
    if (!filter.trim()) return null;
    const q = filter.toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (
        s.display_name.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.cruise_line.toLowerCase().includes(q) ||
        String(s.mmsi).includes(q)
      )
        out.push(i);
    }
    return out;
  }, [filter, ships]);

  const rowCount = visibleShipIdx ? visibleShipIdx.length : ships.length;
  const totalW = HEADER_W + dates.length * CELL_W;
  const totalH = HEADER_H + rowCount * CELL_H;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    });
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
      pending = requestAnimationFrame(() => {
        pending = 0;
        setRenderTick((n) => (n + 1) | 0);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (pending) cancelAnimationFrame(pending);
    };
  }, []);

  // Re-render canvas after every render of the component.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const vw = viewport.w;
    const vh = viewport.h;
    if (!vw || !vh) return;

    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sx = scrollPosRef.current.x;
    const sy = scrollPosRef.current.y;

    // Background
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, vw, vh);

    // Visible body cell range (in column/row index space).
    // Body cell c is drawn at canvas x = HEADER_W + c*CELL_W - sx.
    // We want canvas x in [HEADER_W, vw].
    const firstCol = Math.max(0, Math.floor(sx / CELL_W));
    const lastCol = Math.min(
      dates.length - 1,
      Math.ceil((sx + vw - HEADER_W) / CELL_W),
    );
    const firstRow = Math.max(0, Math.floor(sy / CELL_H));
    const lastRow = Math.min(
      rowCount - 1,
      Math.ceil((sy + vh - HEADER_H) / CELL_H),
    );

    // Clip body region so cells don't paint over the headers.
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, HEADER_H, vw - HEADER_W, vh - HEADER_H);
    ctx.clip();

    // Row striping for visible rows
    for (let r = firstRow; r <= lastRow; r++) {
      if (r % 2 !== 0) continue;
      const y = HEADER_H + r * CELL_H - sy;
      ctx.fillStyle = "#111";
      ctx.fillRect(HEADER_W, y, vw - HEADER_W, CELL_H);
    }

    // Body cells — color depends on mode.
    for (let r = firstRow; r <= lastRow; r++) {
      const shipIdx = visibleShipIdx ? visibleShipIdx[r] : r;
      const vt = voyage.t[shipIdx];
      const vv = voyage.v[shipIdx];
      const st = silver.t[shipIdx];
      const sv = silver.v[shipIdx];
      const y = HEADER_H + r * CELL_H - sy;
      for (let c = firstCol; c <= lastCol; c++) {
        const vtt = vt[c];
        const stt = st[c];
        let fill: string | null = null;
        if (mode === "voyage") {
          if (vtt === 0) continue;
          fill = `rgba(16, 185, 129, ${densityAlpha(vtt)})`;
        } else if (mode === "silver") {
          if (stt === 0) continue;
          fill = `rgba(20, 184, 166, ${densityAlpha(stt)})`;
        } else if (mode === "ratio") {
          // visible-on-globe ratio for voyage layer
          if (vtt === 0) continue;
          fill = ratioColor(vv[c], vtt);
        } else {
          // combined: voyage+silver status
          const has_v = vtt > 0;
          const has_s = stt > 0;
          if (!has_v && !has_s) continue;
          if (has_v && has_s) {
            // cleaned (both layers present)
            const a = densityAlpha(Math.max(vtt, stt));
            fill = `rgba(16, 185, 129, ${a})`; // emerald
          } else if (has_v && !has_s) {
            // backlog (voyage only — not yet cleaned to silver)
            fill = `rgba(245, 158, 11, ${densityAlpha(vtt)})`; // amber
          } else {
            // silver only — orphan
            fill = `rgba(59, 130, 246, ${densityAlpha(stt)})`; // blue
          }
        }
        if (!fill) continue;
        ctx.fillStyle = fill;
        ctx.fillRect(HEADER_W + c * CELL_W - sx, y, CELL_W - 1, CELL_H - 1);
      }
    }

    // Selection highlight
    if (selection) {
      const r = visibleShipIdx
        ? visibleShipIdx.indexOf(selection.shipIdx)
        : selection.shipIdx;
      if (r >= 0) {
        const x = HEADER_W + selection.dateIdx * CELL_W - sx;
        const y = HEADER_H + r * CELL_H - sy;
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1);
      }
    }

    ctx.restore();

    // Top header (dates)
    ctx.fillStyle = "#171717";
    ctx.fillRect(HEADER_W, 0, vw - HEADER_W, HEADER_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, 0, vw - HEADER_W, HEADER_H);
    ctx.clip();
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    let prevYear = "";
    let prevMonth = "";
    for (let c = firstCol; c <= lastCol; c++) {
      const d = dates[c];
      const yr = d.slice(0, 4);
      const mo = d.slice(5, 7);
      const x = HEADER_W + c * CELL_W - sx;
      if (yr !== prevYear) {
        ctx.fillStyle = "#404040";
        ctx.fillRect(x, 0, 1, HEADER_H);
        ctx.fillStyle = "#fafafa";
        ctx.fillText(yr, x + 3, 10);
        prevYear = yr;
        prevMonth = "";
      }
      if (mo !== prevMonth) {
        ctx.fillStyle = "#a3a3a3";
        ctx.fillText(mo, x + 3, 24);
        prevMonth = mo;
      }
    }
    ctx.restore();

    // Left header (ships)
    ctx.fillStyle = "#171717";
    ctx.fillRect(0, 0, HEADER_W, vh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_H, HEADER_W, vh - HEADER_H);
    ctx.clip();
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (let r = firstRow; r <= lastRow; r++) {
      const shipIdx = visibleShipIdx ? visibleShipIdx[r] : r;
      const ship = ships[shipIdx];
      const yTop = HEADER_H + r * CELL_H - sy;
      if (r % 2 === 0) {
        ctx.fillStyle = "#1c1c1c";
        ctx.fillRect(0, yTop, HEADER_W, CELL_H);
      }
      ctx.fillStyle = ship.in_service ? "#fafafa" : "#737373";
      const label = `${ship.display_name} · ${ship.cruise_line}`;
      ctx.fillText(label.slice(0, 32), 6, yTop + CELL_H / 2);
    }
    ctx.restore();

    // Top-left corner
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, HEADER_W, HEADER_H);
    ctx.fillStyle = "#fafafa";
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`${rowCount} ships × ${dates.length} days`, 6, HEADER_H / 2);

    // Header borders
    ctx.fillStyle = "#262626";
    ctx.fillRect(0, HEADER_H - 1, vw, 1);
    ctx.fillRect(HEADER_W - 1, 0, 1, vh);
  });

  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (cx < HEADER_W || cy < HEADER_H) return;
      const sx = scrollPosRef.current.x;
      const sy = scrollPosRef.current.y;
      const c = Math.floor((cx - HEADER_W + sx) / CELL_W);
      const r = Math.floor((cy - HEADER_H + sy) / CELL_H);
      if (c < 0 || c >= dates.length || r < 0 || r >= rowCount) return;
      const shipIdx = visibleShipIdx ? visibleShipIdx[r] : r;
      const ship = ships[shipIdx];
      const date = dates[c];
      const v = payload.voyage_cells[String(ship.mmsi)]?.[date];
      const s = payload.silver_cells[String(ship.mmsi)]?.[date];
      setSelection({ shipIdx, dateIdx: c, voyage: v, silver: s });
    },
    [dates, payload, rowCount, ships, visibleShipIdx],
  );

  const selShip = selection ? ships[selection.shipIdx] : null;
  const selDate = selection ? dates[selection.dateIdx] : null;

  return (
    <div className="flex flex-col h-full w-full bg-neutral-950 text-neutral-100">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-neutral-800 text-sm flex-wrap">
        <div className="font-semibold">AIS Coverage</div>
        <div className="flex rounded overflow-hidden border border-neutral-700 text-xs">
          {(
            [
              ["combined", "combined"],
              ["voyage", "voyage"],
              ["silver", "silver"],
              ["ratio", "v/t ratio"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`px-2 py-1 ${mode === k ? "bg-emerald-700" : "bg-neutral-900 hover:bg-neutral-800"}`}
              onClick={() => setMode(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter ships…"
          className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm w-56"
        />
        <Legend mode={mode} />
        <div className="text-neutral-400 text-xs ml-auto">
          {payload.date_range.start} → {payload.date_range.end} · click cell for
          details
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="relative flex-1 overflow-auto"
          style={{ contain: "strict" }}
        >
          <div
            style={{
              width: totalW,
              height: totalH,
              position: "relative",
            }}
          >
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              style={{
                position: "sticky",
                top: 0,
                left: 0,
                width: viewport.w,
                height: viewport.h,
                display: "block",
                cursor: "crosshair",
              }}
            />
          </div>
        </div>
        {selection && selShip && selDate && (
          <aside className="w-80 border-l border-neutral-800 p-3 text-sm overflow-auto bg-neutral-950">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-semibold">{selShip.display_name}</div>
                <div className="text-neutral-400 text-xs">
                  {selShip.cruise_line} · MMSI {selShip.mmsi} · IMO{" "}
                  {selShip.imo_number}
                </div>
              </div>
              <button
                className="text-neutral-400 hover:text-white"
                onClick={() => setSelection(null)}
              >
                ✕
              </button>
            </div>
            <div className="text-neutral-400 text-xs mb-3">{selDate}</div>
            <Section title="voyage" cell={selection.voyage} />
            <Section title="silver" cell={selection.silver} />
          </aside>
        )}
      </div>
    </div>
  );
}

function Legend({ mode }: { mode: Mode }) {
  const swatches: { color: string; label: string }[] =
    mode === "combined"
      ? [
          { color: "rgba(16,185,129,0.85)", label: "cleaned (both)" },
          { color: "rgba(245,158,11,0.85)", label: "backlog (voyage only)" },
          { color: "rgba(59,130,246,0.85)", label: "silver only" },
          { color: "#262626", label: "no data" },
        ]
      : mode === "voyage"
        ? [
            { color: "rgba(16,185,129,0.4)", label: "low t" },
            { color: "rgba(16,185,129,1)", label: "high t" },
          ]
        : mode === "silver"
          ? [
              { color: "rgba(20,184,166,0.4)", label: "low t" },
              { color: "rgba(20,184,166,1)", label: "high t" },
            ]
          : [
              { color: "hsl(0,75%,50%)", label: "v/t = 0" },
              { color: "hsl(65,75%,50%)", label: "0.5" },
              { color: "hsl(130,75%,50%)", label: "1.0" },
            ];
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-400">
      {swatches.map((s) => (
        <div key={s.label} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-neutral-700"
            style={{ backgroundColor: s.color }}
          />
          {s.label}
        </div>
      ))}
    </div>
  );
}

function Section({ title, cell }: { title: string; cell?: Cell }) {
  return (
    <div className="mb-3">
      <div className="font-medium mb-1 capitalize">{title}</div>
      {cell ? (
        <table className="text-xs w-full">
          <tbody>
            {(Object.keys(cell) as (keyof Cell)[]).map((k) => (
              <tr key={k} className="border-b border-neutral-800">
                <td className="py-0.5 text-neutral-400">{k}</td>
                <td className="py-0.5 text-right tabular-nums">{cell[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-neutral-500 text-xs">no data</div>
      )}
    </div>
  );
}
