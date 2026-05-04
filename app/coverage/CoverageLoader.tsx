"use client";

import { useEffect, useState } from "react";
import CoverageGrid from "./CoverageGrid";
import type { CoveragePayload } from "./types";

export default function CoverageLoader() {
  const [payload, setPayload] = useState<CoveragePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    received: number;
    total: number | null;
  }>({ received: 0, total: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/coverage");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const totalHeader = res.headers.get("content-length");
        const total = totalHeader ? Number(totalHeader) : null;
        if (!res.body) {
          const json = await res.json();
          if (!cancelled) setPayload(json);
          return;
        }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        // Stream chunks so we can show progress on the 64MB payload.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          if (!cancelled) setProgress({ received, total });
        }
        if (cancelled) return;
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        const text = new TextDecoder().decode(merged);
        const json = JSON.parse(text) as CoveragePayload;
        if (!cancelled) setPayload(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="p-6 text-red-400 bg-neutral-950 h-full">
        Failed to load coverage data: {error}
      </div>
    );
  }
  if (!payload) {
    const pct =
      progress.total && progress.total > 0
        ? Math.round((progress.received / progress.total) * 100)
        : null;
    return (
      <div className="p-6 text-neutral-400 bg-neutral-950 h-full font-mono text-sm">
        Loading coverage data…{" "}
        {pct !== null
          ? `${pct}% (${(progress.received / 1024 / 1024).toFixed(1)} / ${
              ((progress.total ?? 0) / 1024 / 1024).toFixed(1)
            } MB)`
          : `${(progress.received / 1024 / 1024).toFixed(1)} MB`}
      </div>
    );
  }
  return <CoverageGrid payload={payload} />;
}
