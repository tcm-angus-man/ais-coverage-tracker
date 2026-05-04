import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "./auth-provider";
import Nav from "@/components/nav";

export const metadata: Metadata = {
  title: "AIS Coverage Tracker",
  description: "Internal coordination layer for AIS coverage cleaning",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="bg-neutral-950">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen flex flex-col">
        <AuthProvider>
          <Nav />
          <main className="flex-1 min-h-0">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
