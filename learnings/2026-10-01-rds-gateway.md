# Moving Postgres reads behind the Cruise Globe Dashboard gateway

**Problem:** Production RDS was IP-restricted, so the Vercel deployment could no longer open a `pg` pool; five routes had to call the Cruise Globe Dashboard gateway instead, with no change visible to the UI.

## Approach

1. Read the gateway side first (`../Cruise Globe Dashboard/app/api/gateway/ais/*/route.ts`, `lib/gateway/auth.ts`, `lib/gateway/ais-snapshot/metadata.ts`). It defines the contract: bearer-token auth per client, `{ ok: true, ... }` on success, `{ ok: false, error }` with a redacted message on failure, and for `/progress` the old response *minus* `display_name`/`slug`.
2. Read the five ais routes and list what each one keeps: auth/role checks, the Sheets read (snapshot metadata, shared-MMSI diff), and the roster enrichment (`memberByUserId`). Only the `pool.query` calls move.
3. Write the tests first and watch them fail for the right reason:
   - `tests/lib/gateway.test.ts`: URL building (trailing slash), bearer header, `cache: "no-store"`, POST body, non-2xx, 200 with `ok:false`, non-JSON body, timeout, missing env vars fail before fetching, and metadata-sheet failure still builds with `[]`.
   - `tests/api/gateway-routes.test.ts`: role gating for all five routes (gateway never called when rejected), progress enrichment with roster fallbacks, and `vi.mock("@/lib/snapshot/db", () => { throw ... })`. That mock makes the import fail if any route still loads the pool, directly or transitively, so the "no `app/` route imports `lib/snapshot/db`" rule is now tested rather than only checked with grep.
4. Add `lib/gateway.ts`: `gatewayFetch<T>(path, { method, body, timeoutMs })`, modelled on tcg-bookings-dashboard's `gatewayPost`, plus `buildSnapshotViaGateway()`, which reads `ship_metadata` here (the gateway has no Sheets credentials) and POSTs it.
5. Swap each route, then run grep for direct and transitive `db` imports (the remaining `lib/snapshot/blob|compress|types` imports have no `db` dependency), typecheck, lint, the full test suite, and `NODE_ENV=production npm run build`.

## Judgment calls

- **No runtime validation of gateway responses.** The type is asserted; the gateway is our own code and its routes are copied verbatim from these ones. Adding zod would double-maintain the shape. The `ok: true` check catches the failure mode that matters (a failure that looks like data).
- **The snapshot timeout is set to 285s, below `maxDuration` 300**, so a stuck build reports a clear error instead of the function being killed. The default timeout is 60s.
- **The metadata fallback stays best-effort.** It is copied from `lib/snapshot/build.ts` (six lines), not imported, because importing that module would pull in `db`. The duplication is intended.
- **Not changed:** `lib/snapshot/*` and `scripts/*` (local VPN use), Sheets code, `vercel.json`, and the inconsistent auth statuses (diag returns 403 to anonymous users while the others return 401). The brief said the auth behaviour stays as it is.
- **No real-data checks.** Nothing ran against `.env`, the gateway, the DB or the sheet. The end-to-end check is the first production cron after deploy.

## Reusable rule

When a data source moves behind a service boundary, move only the queries. Keep auth, roster and config lookups, and response shaping in the caller. Pin the boundary with a test that makes importing the old client fail, not only with a grep.
