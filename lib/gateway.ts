import "server-only";
import { fetchShipMetadataUncached, type ShipMetadata } from "@/lib/sheets/ship-metadata";
import type { BuildResult } from "@/lib/snapshot/build";

// Production RDS is IP-restricted, so this app no longer connects to Postgres
// from Vercel. Every read goes through the Cruise Globe Dashboard gateway
// (`/api/gateway/ais/*`), authenticated with this app's own token. Env names
// match tcg-bookings-dashboard's CRUISE_GATEWAY_URL + GATEWAY_TOKEN_BOOKINGS.

const DEFAULT_TIMEOUT_MS = 60_000;
// Below the route's maxDuration (300s) so a stuck build fails with a clear
// message instead of the function being killed mid-request.
const SNAPSHOT_TIMEOUT_MS = 285_000;

type GatewayOptions = { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number };

/**
 * Calls `${CRUISE_GATEWAY_URL}/api/gateway/<path>` and returns the JSON body.
 * Throws on a missing env var, a timeout, a non-2xx status, or a body that is
 * not `{ ok: true, ... }`. The returned type is asserted, not validated.
 */
export async function gatewayFetch<T>(path: string, opts: GatewayOptions = {}): Promise<T> {
  const base = process.env.CRUISE_GATEWAY_URL;
  const token = process.env.GATEWAY_TOKEN_AIS;
  if (!base) throw new Error("missing CRUISE_GATEWAY_URL");
  if (!token) throw new Error("missing GATEWAY_TOKEN_AIS");

  const { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  let json: unknown;
  try {
    // The timeout signal also covers reading the body, so a stalled response cannot hang.
    res = await fetch(`${base.replace(/\/+$/, "")}/api/gateway/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${path}: gateway timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const reply = json as { ok?: unknown; error?: unknown } | null;
  const detail = typeof reply?.error === "string" ? ` ${reply.error}` : "";
  if (!res.ok) throw new Error(`${path}: gateway ${res.status}${detail}`);
  if (reply?.ok !== true) {
    throw new Error(`${path}: unexpected response from gateway (status ${res.status})${detail}`);
  }
  return json as T;
}

// Best-effort, as in lib/snapshot/build.ts: if the sheet read fails, every
// ship defaults to Tier 4 with no service window so the cron still produces
// a snapshot.
async function fetchShipMetadataSafe(): Promise<ShipMetadata[]> {
  try {
    return await fetchShipMetadataUncached();
  } catch (err) {
    console.error("[snapshot] ship_metadata fetch failed, defaulting all ships to Tier 4:", err);
    return [];
  }
}

/**
 * Reads the ship_metadata sheet here (the gateway has no Sheets access) and
 * asks the gateway to run the snapshot queries and write the Blob. Returns
 * the build summary; the snapshot itself never comes back over the wire.
 */
export async function buildSnapshotViaGateway(): Promise<BuildResult> {
  const metadata = await fetchShipMetadataSafe();
  const { ok: _ok, ...summary } = await gatewayFetch<BuildResult & { ok: true }>("ais/snapshot", {
    method: "POST",
    body: { metadata },
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
  return summary;
}
