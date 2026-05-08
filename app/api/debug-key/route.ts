import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "assigner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "";
  const replaced = raw.replace(/\\n/g, "\n").replace(/^"|"$/g, "");

  return NextResponse.json({
    length: raw.length,
    startsWithQuote: raw.startsWith('"'),
    endsWithQuote: raw.endsWith('"'),
    firstChars: raw.slice(0, 30),
    lastChars: raw.slice(-30),
    containsLiteralBackslashN: raw.includes("\\n"),
    containsActualNewline: raw.includes("\n"),
    afterReplaceFirstChars: replaced.slice(0, 30),
    afterReplaceLastChars: replaced.slice(-30),
    afterReplaceLength: replaced.length,
  });
}
