import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { AddressInfo } from "node:net";

// The blob layer is mocked so this test never touches Vercel Blob or any
// production data — per .claude/rules/data-privacy.md we work on shapes only.
const readCoverageBlobWithMeta = vi.fn();
vi.mock("@/lib/snapshot/blob", () => ({
  COVERAGE_BLOB_KEY: "coverage-latest.json.br",
  putCoverageBlob: vi.fn(),
  readCoverageBlob: () => Promise.resolve(readCoverageBlobWithMeta().then((r: { body: Buffer }) => r.body)),
  readCoverageBlobWithMeta: () => readCoverageBlobWithMeta(),
}));

import { GET } from "@/app/api/coverage/route";

// A payload of the right *shape*. Values are synthetic.
const PAYLOAD = {
  generated_at: "2026-09-21T09:00:00.000Z",
  date_range: { start: "2015-01-01", end: "2026-09-21" },
  ships: [{ id: 1, mmsi: 200000001, name: "SHIP A", display_name: "Ship A", cruise_line: "Line", imo_number: "9000001", in_service: true, cruise_type: "Ocean Cruise", service_start: null, service_end: null, tier: 2 }],
  dates: ["2015-01-01", "2026-09-21"],
  voyage_cells: { "1": { "2015-01-01": { t: 1, v: 1, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0 } } },
  silver_cells: { "1": { "2015-01-01": { t: 900, v: 900, na: 0, dw: 0, np: 0, dt: 0, dd: 0, sp: 0, ol: 0, u: 0 } } },
};
const JSON_BYTES = Buffer.from(JSON.stringify(PAYLOAD), "utf8");
const BR_BYTES = brotliCompressSync(JSON_BYTES, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
});

beforeEach(() => {
  readCoverageBlobWithMeta.mockReset();
  readCoverageBlobWithMeta.mockResolvedValue({
    body: new Uint8Array(BR_BYTES),
    etag: "abc123etag",
    uploadedAt: "2026-09-21T09:00:01.000Z",
  });
});

describe("GET /api/coverage", () => {
  // The whole point of the change: the response body must be the stored bytes,
  // byte for byte. If someone reintroduces a decompress/re-stringify step this
  // fails, because the body would come back as uncompressed JSON.
  it("serves the stored brotli bytes verbatim, without re-serialising", async () => {
    const res = await GET();
    const body = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(body.equals(BR_BYTES)).toBe(true);
    expect(body.length).toBeLessThan(JSON_BYTES.length);
  });

  it("sets the headers a browser needs to decode it", async () => {
    const res = await GET();
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-encoding")).toBe("br");
  });

  // Cache behaviour is documented in .claude/rules/snapshot-conventions.md and
  // must track the hourly cron. `no-store` meant every page load re-paid the
  // full cost of the route.
  it("caches for the cron cadence rather than no-store", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("cache-control")).not.toContain("no-store");
  });

  it("tags the response with the blob etag so revalidation works", async () => {
    const res = await GET();
    expect(res.headers.get("etag")).toBe('"abc123etag"');
  });

  it("still decompresses to the original payload", async () => {
    const res = await GET();
    const body = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(brotliDecompressSync(body).toString("utf8"))).toEqual(PAYLOAD);
  });
});

// End-to-end over real HTTP: proves an HTTP client transparently decodes the
// Content-Encoding we set, which is what lets CoverageLoader's existing
// fetch → TextDecoder → JSON.parse path keep working untouched.
describe("GET /api/coverage over the wire", () => {
  let server: Server;
  afterAll(() => new Promise<void>(r => { server?.close(() => r()); }));

  it("is transparently decoded by a real fetch client", async () => {
    const res0 = await GET();
    const bytes = Buffer.from(await res0.arrayBuffer());
    const headers = Object.fromEntries(res0.headers.entries());

    server = createServer((_req, resp) => { resp.writeHead(200, headers); resp.end(bytes); });
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/coverage`);
    // No manual brotli decode here — the client did it for us.
    const parsed = await res.json();
    expect(parsed).toEqual(PAYLOAD);
  });
});
