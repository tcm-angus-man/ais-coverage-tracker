import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Session, gateway and Sheets are mocked; rows are synthetic (data-privacy rule).
const getServerSession = vi.fn();
vi.mock("next-auth/next", () => ({ getServerSession: (...a: unknown[]) => getServerSession(...a) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const gatewayFetch = vi.fn();
const buildSnapshotViaGateway = vi.fn();
vi.mock("@/lib/gateway", () => ({
  gatewayFetch: (...a: unknown[]) => gatewayFetch(...a),
  buildSnapshotViaGateway: () => buildSnapshotViaGateway(),
}));

const sheetsGet = vi.fn();
const sheetsAppend = vi.fn();
vi.mock("@/lib/sheets/client", () => ({
  sheetsGet: (...a: unknown[]) => sheetsGet(...a),
  sheetsAppend: (...a: unknown[]) => sheetsAppend(...a),
}));

vi.mock("@/lib/sheets/team-config", () => ({
  memberByUserId: (id: string) => (id === "11" ? { display_name: "Bea", slug: "bea" } : undefined),
}));

// Production RDS is IP-restricted to the gateway. If any of these routes
// still loads the direct Postgres pool, importing it fails this file.
vi.mock("@/lib/snapshot/db", () => {
  throw new Error("app routes must not import lib/snapshot/db — call the gateway");
});

import { GET as cronGET } from "@/app/api/cron/snapshot/route";
import { POST as rebuildPOST } from "@/app/api/snapshot/rebuild/route";
import { GET as progressGET } from "@/app/api/progress/route";
import { GET as diagGET } from "@/app/api/snapshot/diag/route";
import { GET as sharedMmsiGET } from "@/app/api/admin/ship-metadata-fill-shared-mmsi/route";

const ASSIGNER = { slug: "angus", role: "assigner", db_user_id: "1", display_name: "Angus" };
const CLEANER = { slug: "bea", role: "cleaner", db_user_id: "11", display_name: "Bea" };
const asUser = (user: object | null) =>
  getServerSession.mockResolvedValue(user ? { expires: "2099-01-01", user } : null);
const read = async (res: Response) => ({ status: res.status, json: await res.json() });

const SUMMARY = {
  generated_at: "2026-10-01T09:00:00.000Z", ships: 1, voyage_cell_rows: 2,
  silver_cell_rows: 3, bytes_compressed: 4, blob: { url: "https://blob.example.test/x" },
};

beforeEach(() => {
  [getServerSession, gatewayFetch, buildSnapshotViaGateway, sheetsGet, sheetsAppend].forEach(m => m.mockReset());
  buildSnapshotViaGateway.mockResolvedValue(SUMMARY);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/cron/snapshot", () => {
  const cron = (auth?: string) =>
    cronGET(new Request("http://localhost/api/cron/snapshot", { headers: auth ? { authorization: auth } : {} }));

  it("rejects a request without the cron secret and never reaches the gateway", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong")).status).toBe(401);
    expect(buildSnapshotViaGateway).not.toHaveBeenCalled();
  });

  it("refuses in production when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await cron()).status).toBe(401);
    expect(buildSnapshotViaGateway).not.toHaveBeenCalled();
  });

  it("returns the gateway's build summary", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    const { status, json } = await read(await cron("Bearer cron-secret"));
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, ...SUMMARY });
  });

  // A failed build must be visible to Vercel Cron as a failed run, not a 200.
  it("returns 500 with the error when the gateway build fails", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    buildSnapshotViaGateway.mockRejectedValue(new Error("gateway 500 statement timeout"));
    const { status, json } = await read(await cron("Bearer cron-secret"));
    expect(status).toBe(500);
    expect(json).toEqual({ ok: false, error: "gateway 500 statement timeout" });
  });
});

describe("POST /api/snapshot/rebuild", () => {
  it("is assigner-only", async () => {
    asUser(null);
    expect((await rebuildPOST()).status).toBe(401);
    asUser(CLEANER);
    expect((await rebuildPOST()).status).toBe(403);
    expect(buildSnapshotViaGateway).not.toHaveBeenCalled();
  });

  it("returns the gateway's build summary for an assigner", async () => {
    asUser(ASSIGNER);
    expect(await read(await rebuildPOST())).toEqual({ status: 200, json: { ok: true, ...SUMMARY } });
  });
});

describe("GET /api/progress", () => {
  it("requires a session", async () => {
    asUser(null);
    expect((await progressGET()).status).toBe(401);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  // The gateway omits roster fields; the progress page renders display_name
  // and keys charts on slug, so they must be re-added here from TEAM_MEMBERS,
  // with the same fallbacks as before for an id not on the roster.
  it("adds display_name and slug from the roster to the gateway rows", async () => {
    asUser(CLEANER);
    gatewayFetch.mockResolvedValue({
      ok: true,
      reviewers: [
        { user_id: "11", days_cleaned: 5, last_active: "2026-09-30", daily: [], daily30: [] },
        { user_id: "99", days_cleaned: 1, last_active: "2026-09-29", daily: [], daily30: [] },
      ],
      totals: { total_days: 10, clean_days: 6 },
      recent: [{ updated_by: "11", ship_name: "Ship A", mmsi: 200000001, date: "2026-09-30", updated_at: "2026-09-30 10:00:00" }],
      today: [{ user_id: "99", count: 2, last_updated_at: "2026-10-01 08:00:00" }],
      today_hourly: [{ user_id: "11", hours: new Array(24).fill(0) }],
    });

    const { status, json } = await read(await progressGET());

    expect(gatewayFetch).toHaveBeenCalledWith("ais/progress");
    expect(status).toBe(200);
    expect(json.reviewers[0]).toMatchObject({ user_id: "11", display_name: "Bea", slug: "bea", days_cleaned: 5 });
    expect(json.reviewers[1]).toMatchObject({ user_id: "99", display_name: "User 99", slug: "99" });
    expect(json.totals).toEqual({ total_days: 10, clean_days: 6 });
    expect(json.recent[0]).toMatchObject({ updated_by: "11", ship_name: "Ship A", display_name: "Bea" });
    expect(json.today[0]).toEqual({ user_id: "99", display_name: "User 99", count: 2, last_updated_at: "2026-10-01 08:00:00" });
    expect(json.today_hourly[0]).toMatchObject({ user_id: "11", display_name: "Bea", slug: "bea" });
    expect(json.today_hourly[0].hours).toHaveLength(24);
  });

  it("returns 500 with the error when the gateway fails", async () => {
    asUser(CLEANER);
    gatewayFetch.mockRejectedValue(new Error("ais/progress: gateway 500"));
    expect(await read(await progressGET())).toEqual({ status: 500, json: { ok: false, error: "ais/progress: gateway 500" } });
  });
});

describe("GET /api/snapshot/diag", () => {
  it("is assigner-only", async () => {
    asUser(null);
    expect((await diagGET()).status).toBe(403);
    asUser(CLEANER);
    expect((await diagGET()).status).toBe(403);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("returns the gateway's diagnostic counts in the same shape", async () => {
    asUser(ASSIGNER);
    const diag = {
      total_rows: 10, human_touched_rows: 4,
      by_updated_by: [{ updated_by: null, count: 6 }],
      recent_human_touched: [{ mmsi: 200000001, date: "2026-09-30", updated_by: "11", updated_at: "2026-09-30 10:00:00" }],
    };
    gatewayFetch.mockResolvedValue({ ok: true, ...diag });
    expect(await read(await diagGET())).toEqual({ status: 200, json: { ok: true, ...diag } });
    expect(gatewayFetch).toHaveBeenCalledWith("ais/snapshot-diag");
  });
});

describe("GET /api/admin/ship-metadata-fill-shared-mmsi", () => {
  const call = () => sharedMmsiGET(new Request("http://localhost/api/admin/ship-metadata-fill-shared-mmsi"));

  it("is assigner-only", async () => {
    asUser(null);
    expect((await call()).status).toBe(401);
    asUser(CLEANER);
    expect((await call()).status).toBe(403);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("diffs the gateway's ship list against the sheet (dry run)", async () => {
    asUser(ASSIGNER);
    gatewayFetch.mockResolvedValue({
      ok: true,
      rows: [
        { mmsi: 200000001, ship_name: "Ship A", cruise_line: "Line" },
        { mmsi: 200000001, ship_name: "Ship A Renamed", cruise_line: "Line" },
      ],
    });
    sheetsGet.mockResolvedValue([
      ["ship_name", "cruise_line", "mmsi", "cruise_type", "service_start", "service_end", "tier"],
      ["Ship A", "Line", "200000001", "Ocean Cruise", "", "", "2"],
    ]);

    const { status, json } = await read(await call());

    expect(gatewayFetch).toHaveBeenCalledWith("ais/shared-mmsi-ships");
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, applied: false, db_ships: 2, to_append_count: 1 });
    expect(sheetsAppend).not.toHaveBeenCalled();
  });
});
