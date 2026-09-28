import { afterEach, describe, expect, it, vi } from "vitest";

// Every dependency is mocked: no Postgres, no Blob, no Sheets.
const captured: { payload?: Record<string, unknown> } = {};
const T0 = new Date("2026-09-28T10:00:00.000Z");
const T1 = new Date("2026-09-28T10:04:00.000Z");

vi.mock("@/lib/snapshot/db", () => ({ getPool: () => ({}), endPool: vi.fn() }));
vi.mock("@/lib/snapshot/queries", () => ({
  // The queries take time; simulate it by moving the clock forward.
  fetchShips: () => { vi.setSystemTime(T1); return Promise.resolve([]); },
  fetchVoyageCells: () => Promise.resolve([]),
  fetchSilverCells: () => Promise.resolve([]),
  buildDateAxis: () => ["2026-09-28"],
}));
vi.mock("@/lib/snapshot/compress", () => ({
  compressJson: (p: Record<string, unknown>) => { captured.payload = p; return Promise.resolve(Buffer.from("x")); },
}));
vi.mock("@/lib/snapshot/blob", () => ({ putCoverageBlob: () => Promise.resolve({}) }));
vi.mock("@/lib/sheets/ship-metadata", () => ({
  fetchShipMetadataUncached: () => Promise.resolve([]),
  indexByVessel: () => new Map(), indexByMmsi: () => new Map(), indexByImo: () => new Map(),
  vesselKey: () => "",
}));

import { buildSnapshot } from "@/lib/snapshot/build";

afterEach(() => { vi.useRealTimers(); });

describe("buildSnapshot", () => {
  // /gaps compares an assignment's completed_at against data_as_of to decide
  // "awaiting snapshot" vs "reopened". generated_at is stamped after the
  // queries, so work completed mid-cron would look reopened. data_as_of must
  // be the time BEFORE the queries read Postgres.
  it("stamps data_as_of before the queries run, and generated_at after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);

    await buildSnapshot();

    expect(captured.payload?.data_as_of).toBe(T0.toISOString());
    expect(captured.payload?.generated_at).toBe(T1.toISOString());
  });
});
