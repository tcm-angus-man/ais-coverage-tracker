"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 32 }}>
      <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 26, color: "var(--ink)", letterSpacing: "-0.02em" }}>
        Something went wrong
      </div>
      <button
        onClick={reset}
        style={{
          marginTop: 20, padding: "8px 20px", background: "var(--accent)", color: "#1a1207",
          border: "none", borderRadius: 3, fontSize: 12, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer", letterSpacing: "0.04em",
        }}
      >
        Retry
      </button>
    </div>
  );
}
