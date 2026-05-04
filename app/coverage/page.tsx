import CoverageLoader from "./CoverageLoader";

export const dynamic = "force-dynamic";

export default function CoveragePage() {
  return (
    <div className="h-[calc(100vh-44px)] w-full">
      <CoverageLoader />
    </div>
  );
}
