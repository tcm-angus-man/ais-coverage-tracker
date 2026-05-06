"use client";

import { useEffect, useState } from "react";
import CoverageGrid from "./CoverageGrid";
import type { CoveragePayload } from "./types";
import type { ShellMode } from "./CoverageShell";

async function fetchWithRetry(
  url: string,
  onProgress: (r: number, t: number | null) => void,
  signal: AbortSignal,
): Promise<CoveragePayload> {
  const MAX_TRIES = 5;
  let delay = 1000;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = res.headers.get("content-length") ? Number(res.headers.get("content-length")) : null;
      if (!res.body) return await res.json() as CoveragePayload;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(received, total);
      }
      const merged = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
      return JSON.parse(new TextDecoder().decode(merged)) as CoveragePayload;
    } catch (e) {
      if (signal.aborted) throw new Error("aborted");
      if (attempt === MAX_TRIES - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
      onProgress(0, null);
    }
  }
  throw new Error("unreachable");
}

export default function CoverageLoader({ modeOverride = "voyage" }: { modeOverride?: ShellMode }) {
  const [payload, setPayload] = useState<CoveragePayload | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<{ received: number; total: number | null }>({ received: 0, total: null });

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    setProgress({ received: 0, total: null });
    fetchWithRetry("/api/coverage", (r, t) => setProgress({ received: r, total: t }), ac.signal)
      .then(p => setPayload(p))
      .catch(e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => ac.abort();
  }, [attempt]);

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", background: "var(--bg)", gap: 16 }}>
        <div style={{ fontSize: 11, color: "var(--review-edge)" }}>Failed to load: {error}</div>
        <button
          onClick={() => { setError(null); setAttempt(a => a + 1); }}
          style={{ padding: "6px 16px", background: "var(--accent)", color: "#1a1207", border: "none", borderRadius: 3, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!payload) {
    const pct = progress.total && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null;
    const mb  = (progress.received / 1024 / 1024).toFixed(1);
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", background: "var(--bg)", gap: 12 }}>
        <div style={{ fontSize: 11, color: "var(--ink-dim)" }}>Loading coverage data…</div>
        <div style={{ width: 192, height: 2, background: "var(--line)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "var(--clean)", width: pct !== null ? `${pct}%` : "0%", transition: "width 150ms" }} />
        </div>
        <div style={{ fontSize: 10, color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
          {pct !== null ? `${pct}% · ${mb} / ${((progress.total ?? 0) / 1024 / 1024).toFixed(1)} MB` : `${mb} MB`}
        </div>
      </div>
    );
  }

  return <CoverageGrid payload={payload} mode={modeOverride} />;
}
