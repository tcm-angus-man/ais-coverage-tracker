import CoverageShell from "@/app/coverage/CoverageShell";

export const dynamic = "force-dynamic";

export default function CleanlinessPage() {
  return <CoverageShell initialMode="silver" />;
}
