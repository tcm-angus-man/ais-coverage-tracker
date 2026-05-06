export default function NotFound() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 32 }}>
      <div style={{ fontFamily: "Fraunces, serif", fontWeight: 300, fontSize: 72, color: "var(--line-2)", letterSpacing: "-0.04em", lineHeight: 1 }}>
        404
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Page not found
      </div>
    </div>
  );
}
