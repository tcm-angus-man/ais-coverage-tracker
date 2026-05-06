"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export default function SignInPage() {
  const [loading, setLoading] = useState(false);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg)",
    }}>
      <div style={{
        width: 360, background: "var(--panel)",
        border: "1px solid var(--line)", borderRadius: 6, padding: "36px 32px",
        display: "flex", flexDirection: "column", gap: 28,
      }}>
        {/* Wordmark */}
        <div>
          <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--accent)", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-block", width: 20, height: 1, background: "var(--accent)" }} />
            The Cruise Group
          </div>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 400, fontSize: 26, color: "var(--ink)", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
            AIS <em style={{ fontStyle: "italic", fontWeight: 300, color: "var(--accent)" }}>Coverage</em> Tracker
          </div>
          <div style={{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontWeight: 300, fontSize: 13, color: "var(--ink-dim)", marginTop: 6 }}>
            Sign in with your @thecruisemaps.com account.
          </div>
        </div>

        <button
          disabled={loading}
          onClick={() => { setLoading(true); signIn("google", { callbackUrl: "/coverage" }); }}
          style={{
            width: "100%",
            background: loading ? "var(--line-2)" : "var(--accent)",
            color: loading ? "var(--ink-faint)" : "#1a1207",
            border: "none", borderRadius: 3, padding: "10px 0",
            fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
            cursor: loading ? "not-allowed" : "pointer", letterSpacing: "0.04em",
            transition: "background 0.15s, color 0.15s",
          }}
        >
          {loading ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </div>
  );
}
