import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetch and the ship_metadata sheet are mocked; nothing here reaches the real
// gateway, Postgres or Sheets. Rows are synthetic (data-privacy rule).
const fetchShipMetadataUncached = vi.fn();
vi.mock("@/lib/sheets/ship-metadata", () => ({
  fetchShipMetadataUncached: () => fetchShipMetadataUncached(),
}));

import { buildSnapshotViaGateway, gatewayFetch } from "@/lib/gateway";

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

beforeEach(() => {
  fetchMock.mockReset();
  fetchShipMetadataUncached.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CRUISE_GATEWAY_URL", "https://gateway.example.test/");
  vi.stubEnv("GATEWAY_TOKEN_AIS", "ais-test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("gatewayFetch", () => {
  it("calls the ais route with the ais bearer token and never caches", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, total_rows: 3 }));

    const body = await gatewayFetch<{ total_rows: number }>("ais/snapshot-diag");

    const [url, init] = lastCall();
    // Trailing slash on the env var must not produce a `//api` path.
    expect(url).toBe("https://gateway.example.test/api/gateway/ais/snapshot-diag");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ais-test-token");
    // A cached gateway read would serve stale progress / a stale build summary.
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body.total_rows).toBe(3);
  });

  it("POSTs a JSON body when one is given", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await gatewayFetch("ais/snapshot", { method: "POST", body: { metadata: [] } });

    const [, init] = lastCall();
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ metadata: [] });
  });

  it("throws on a non-2xx status, carrying the gateway's error string", async () => {
    fetchMock.mockResolvedValue(json(500, { ok: false, error: "statement timeout" }));
    await expect(gatewayFetch("ais/progress")).rejects.toThrow(/500.*statement timeout/);
  });

  // A 200 that says ok:false must not be read as data — the caller would
  // render zeros (or report a successful build) for a failed request.
  it("throws on a 2xx response whose body is { ok: false }", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: false, error: "nope" }));
    await expect(gatewayFetch("ais/progress")).rejects.toThrow(/nope/);
  });

  it("throws on a 2xx response that is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>login</html>", { status: 200 }));
    await expect(gatewayFetch("ais/progress")).rejects.toThrow(/unexpected response/);
  });

  it("throws a timeout error when the gateway does not answer in time", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );
    await expect(gatewayFetch("ais/progress", { timeoutMs: 20 })).rejects.toThrow(/timed out after 20ms/);
  });

  // Fail closed: a missing env var must not send an unauthenticated request
  // (or one to "undefined/api/...").
  it("throws before fetching when CRUISE_GATEWAY_URL or GATEWAY_TOKEN_AIS is unset", async () => {
    vi.stubEnv("GATEWAY_TOKEN_AIS", "");
    await expect(gatewayFetch("ais/progress")).rejects.toThrow(/GATEWAY_TOKEN_AIS/);
    vi.stubEnv("GATEWAY_TOKEN_AIS", "ais-test-token");
    vi.stubEnv("CRUISE_GATEWAY_URL", "");
    await expect(gatewayFetch("ais/progress")).rejects.toThrow(/CRUISE_GATEWAY_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildSnapshotViaGateway", () => {
  const ROW = {
    ship_name: "Ship A", mmsi: 200000001, cruise_type: "Ocean Cruise",
    service_start: null, service_end: null, tier: 2, imo_number: null,
  };
  const SUMMARY = {
    ok: true, generated_at: "2026-10-01T09:00:00.000Z", ships: 1, voyage_cell_rows: 2,
    silver_cell_rows: 3, bytes_compressed: 4, blob: { url: "https://blob.example.test/x" },
  };

  // The gateway has no Sheets access: the tier / service window it applies
  // come only from the rows this app sends.
  it("sends the parsed ship_metadata rows and returns the build summary", async () => {
    fetchShipMetadataUncached.mockResolvedValue([ROW]);
    fetchMock.mockResolvedValue(json(200, SUMMARY));

    const result = await buildSnapshotViaGateway();

    const [url, init] = lastCall();
    expect(url).toBe("https://gateway.example.test/api/gateway/ais/snapshot");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ metadata: [ROW] });
    expect(result.generated_at).toBe(SUMMARY.generated_at);
  });

  // Unchanged behaviour from the in-app build: a sheet failure degrades the
  // snapshot to "all Tier 4" rather than skipping the hourly rebuild.
  it("still builds, with an empty metadata list, when the sheet read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchShipMetadataUncached.mockRejectedValue(new Error("sheets down"));
    fetchMock.mockResolvedValue(json(200, SUMMARY));

    await buildSnapshotViaGateway();

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ metadata: [] });
  });
});
