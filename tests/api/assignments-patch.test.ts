import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ASSIGNMENTS_COLUMNS } from "@/lib/sheets/schemas";

// Sheets and the session are mocked; rows are synthetic (data-privacy rule).
const getServerSession = vi.fn();
vi.mock("next-auth/next", () => ({ getServerSession: (...a: unknown[]) => getServerSession(...a) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
const sheetsGet = vi.fn();
const sheetsAppend = vi.fn();
const sheetsUpdateRow = vi.fn();
vi.mock("@/lib/sheets/client", () => ({
  sheetsGet: (...a: unknown[]) => sheetsGet(...a),
  sheetsAppend: (...a: unknown[]) => sheetsAppend(...a),
  sheetsUpdateRow: (...a: unknown[]) => sheetsUpdateRow(...a),
}));

import { PATCH } from "@/app/api/sheets/assignments/[id]/route";

type Column = (typeof ASSIGNMENTS_COLUMNS)[number];
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-28T10:00:00.000Z";
const BASE: Record<Column, string> = {
  assignment_id: ID, created_at: "2026-09-01T00:00:00.000Z", created_by: "mon",
  ship_mmsi: "200000001", ship_name: "Ship A", cruise_line: "Line",
  date_start: "2024-01-01", date_end: "2024-01-31", assignee: "nick",
  status: "queued", notes: "", updated_at: "2026-09-01T00:00:00.000Z",
  updated_by: "mon", ship_id: "1", completed_at: "",
};
const rowOf = (over: Partial<Record<Column, string>> = {}) =>
  ASSIGNMENTS_COLUMNS.map(c => ({ ...BASE, ...over })[c]);
const givenRow = (row: string[]) => sheetsGet.mockResolvedValue([[...ASSIGNMENTS_COLUMNS], row]);
const written = () => sheetsUpdateRow.mock.calls[0][1] as string[];
const cell = (row: string[], c: Column) => row[ASSIGNMENTS_COLUMNS.indexOf(c)];
const audit = () => sheetsAppend.mock.calls[0][1][0] as string[];

const BEA = { slug: "bea", role: "cleaner", db_user_id: "11", display_name: "Bea" };

async function call(body: unknown, user: object | null = BEA) {
  getServerSession.mockResolvedValue(user ? { expires: "2099-01-01", user } : null);
  const req = new Request(`http://localhost/api/sheets/assignments/${ID}`, { method: "PATCH", body: JSON.stringify(body) });
  const res = await PATCH(req, { params: { id: ID } });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  [getServerSession, sheetsGet, sheetsAppend, sheetsUpdateRow].forEach(m => m.mockReset());
  sheetsAppend.mockResolvedValue(undefined);
  sheetsUpdateRow.mockResolvedValue(undefined);
  givenRow(rowOf());
});
afterEach(() => { vi.useRealTimers(); });

describe("PATCH /api/sheets/assignments/[id] — permissions", () => {
  // One rule: any active team member may change any assignment.
  it("lets a cleaner reassign someone else's assignment", async () => {
    const { status } = await call({ assignee: "kim" });
    expect(status).toBe(200);
    expect(cell(written(), "assignee")).toBe("kim");
  });

  it("rejects an unauthenticated request", async () => {
    expect((await call({ status: "done" }, null)).status).toBe(401);
  });

  it("rejects a departed member's stale session", async () => {
    const { status } = await call({ status: "done" }, { slug: "jen", role: "cleaner" });
    expect(status).toBe(403);
    expect(sheetsUpdateRow).not.toHaveBeenCalled();
  });
});

describe("PATCH — validation", () => {
  it.each(["jen", "nobody"])("rejects reassigning to %s (inactive or unknown)", async slug => {
    const { status, json } = await call({ assignee: slug });
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(sheetsUpdateRow).not.toHaveBeenCalled();
  });

  it("rejects an unknown status", async () => {
    expect((await call({ status: "archived" })).status).toBe(400);
  });

  it("returns 404 for an id not in the sheet", async () => {
    givenRow(rowOf({ assignment_id: "22222222-2222-4222-8222-222222222222" }));
    expect((await call({ status: "done" })).status).toBe(404);
  });
});

describe("PATCH — completed_at is owned by the server", () => {
  // completed_at is the cutoff that separates new-flow completions from
  // grandfathered legacy done rows, so only the server may set it.
  it("stamps completed_at when status moves into done", async () => {
    await call({ status: "done" });
    expect(cell(written(), "completed_at")).toBe(NOW);
  });

  it("ignores a completed_at supplied in the body", async () => {
    await call({ status: "in_progress", completed_at: "2020-01-01T00:00:00.000Z" });
    expect(cell(written(), "completed_at")).toBe("");
  });

  it("clears completed_at when status leaves done", async () => {
    givenRow(rowOf({ status: "done", completed_at: "2026-09-27T09:00:00.000Z" }));
    await call({ status: "in_progress" });
    expect(cell(written(), "completed_at")).toBe("");
  });

  it("keeps completed_at when a done assignment is only reassigned", async () => {
    givenRow(rowOf({ status: "done", completed_at: "2026-09-27T09:00:00.000Z" }));
    await call({ assignee: "kim" });
    expect(cell(written(), "completed_at")).toBe("2026-09-27T09:00:00.000Z");
  });

  it("stamps a fresh time when completed again after a reopen", async () => {
    givenRow(rowOf({ status: "in_progress", completed_at: "" }));
    await call({ status: "done" });
    expect(cell(written(), "completed_at")).toBe(NOW);
  });

  // Review focus 5 on the write path: a blank status cell is queued, so
  // completing it is a transition INTO done and must stamp — otherwise the row
  // would read as a legacy done and its days would fall back into Unassigned.
  it("stamps completed_at when a blank-status row is marked done", async () => {
    givenRow(rowOf({ status: "", completed_at: "" }));
    const { status, json } = await call({ status: "done" });
    expect(status).toBe(200);
    expect(cell(written(), "status")).toBe("done");
    expect(cell(written(), "completed_at")).toBe(NOW);
    expect(json.updated).toMatchObject({ status: "done", completed_at: NOW });
  });

  // Review focus 1: rows written before column O existed have 14 cells.
  it("pads a legacy 14-cell row and writes all 15 columns", async () => {
    givenRow(rowOf({ status: "done" }).slice(0, 14));
    await call({ status: "in_progress" });
    expect(written()).toHaveLength(15);
    expect(cell(written(), "completed_at")).toBe("");
    expect(sheetsUpdateRow.mock.calls[0][0]).toBe("assignments!A2:O2");
  });
});

describe("PATCH — cancel and audit", () => {
  it("cancelling appends an attributed note and keeps existing notes", async () => {
    givenRow(rowOf({ notes: "[mon @ 2026-09-01T00:00:00.000Z]\nstart with Q1" }));
    await call({ status: "cancelled" });
    expect(cell(written(), "status")).toBe("cancelled");
    expect(cell(written(), "notes")).toBe(
      `[mon @ 2026-09-01T00:00:00.000Z]\nstart with Q1\n\n[bea @ ${NOW}]\ncancelled`,
    );
  });

  // Notes are append-only history: cancelling must not lose what was there,
  // and the audit row must show the notes as they were before the cancel.
  it("cancelling a noted assignment preserves its notes and audits the original", async () => {
    const original = "[mon @ 2026-09-01T00:00:00.000Z]\nstart with Q1\n\n[nick @ 2026-09-02T00:00:00.000Z]\nhalfway";
    givenRow(rowOf({ notes: original }));
    await call({ status: "cancelled" });
    const expected = `${original}\n\n[bea @ ${NOW}]\ncancelled`;
    expect(cell(written(), "notes")).toBe(expected);
    expect(JSON.parse(audit()[5])).toEqual({ status: "queued", notes: original });
    expect(JSON.parse(audit()[6])).toEqual({ status: "cancelled", notes: expected });
  });

  // Review focus 4: notes edit + cancel in one request.
  it("appends the cancel note to the new notes, and audits the original notes", async () => {
    await call({ notes: "moved to Kim's batch", status: "cancelled" });
    expect(cell(written(), "notes")).toBe(`moved to Kim's batch\n\n[bea @ ${NOW}]\ncancelled`);
    expect(JSON.parse(audit()[5]).notes).toBe("");
  });

  it("records the previous values in audit `before`", async () => {
    await call({ status: "in_progress" });
    const row = audit();
    expect(row[1]).toBe("bea");
    expect(row[2]).toBe("update");
    expect(JSON.parse(row[5])).toEqual({ status: "queued" });
    expect(JSON.parse(row[6])).toEqual({ status: "in_progress" });
  });

  it("returns the values it wrote so the client can apply them", async () => {
    const { json } = await call({ status: "done" });
    expect(json).toEqual({
      ok: true,
      updated: { status: "done", assignee: "nick", notes: "", completed_at: NOW, updated_at: NOW, updated_by: "bea" },
    });
  });
});
