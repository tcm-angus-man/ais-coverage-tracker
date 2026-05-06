import CoverageShell from "@/app/coverage/CoverageShell";

export const dynamic = "force-dynamic";

export default function MergedPage() {
  return <CoverageShell initialMode="combined" />;
}
