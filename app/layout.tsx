import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "./auth-provider";
import Nav from "@/components/nav";
import { AssignmentProvider } from "./coverage/AssignmentContext";

export const metadata: Metadata = {
  title: "AIS Coverage Tracker",
  description: "Internal coordination layer for AIS coverage cleaning",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" style={{ height: "100%", background: "#0b1014" }}>
      <body style={{ minHeight: "100%", display: "flex", flexDirection: "column", margin: 0, padding: 0 }}>
        <AuthProvider>
          <AssignmentProvider>
            <Nav />
            <main style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
              {children}
            </main>
          </AssignmentProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
