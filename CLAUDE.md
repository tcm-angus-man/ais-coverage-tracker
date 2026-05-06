# CLAUDE.md — ais-coverage-tracker

Internal Next.js app for The Cruise Group: a coordination layer over the AIS coverage heatmap. Mon's PH cleaning team picks up assignments; assigners (Angus, Mon) hand out work; the heatmap shows what's covered and clean.

Behind Google SSO, gated to `@thecruisemaps.com`. Not customer-facing.

## Stack

- Next.js 14 App Router, TypeScript strict, Tailwind, ESLint
- NextAuth.js (Google provider, JWT sessions)
- Vercel: app + cron + Blob (snapshot store)
- Postgres (read-only, hourly cron only) + Google Sheets (mutable team layer)
- `pg`, `googleapis`, `zod`, Recharts. No ORM.
- Vitest. **Note:** initial scaffold used `npm`; we'd like to switch to `pnpm` once it's installed locally — drop `package-lock.json` and run `pnpm install`.

## Architecture in one paragraph

Postgres is the source of truth for ships, voyages, and silver cleaning. **This app never writes to Postgres.** An hourly Vercel Cron at `/api/cron/snapshot` regenerates a single brotli-compressed `coverage-latest.json` on Vercel Blob. Page renders never run live SQL. Google Sheets holds the mutable assignment + team-config + audit data; the service account does all writes from server routes.

## Key paths

- `app/coverage/` — kept canvas component (CoverageGrid + CoverageLoader + types). **Treat as legacy frozen code in Phase 0–3.** Two surgical props (`renderOverlay`, `onCellClick`) get added in Phase 4.
- `app/api/coverage/route.ts` — Phase 0 returns an inline fixture; Phase 1 streams from Blob.
- `app/api/cron/snapshot/route.ts` — hourly Postgres → Blob (Phase 1).
- `app/api/sheets/*` — assignment + team-config R/W routes.
- `lib/auth.ts` — NextAuth config + domain gate + team_config lookup.
- `lib/roles.ts` — server-side role guards. **Always use these on write routes.**
- `lib/sheets/` — service-account client + zod schemas + read/write helpers.
- `lib/snapshot/` — Phase 1 SQL queries (parameterized, tagged templates, no `.sql` files at runtime).
- `.claude/rules/` — read these before doing meaningful work.
- `docs/` — `plan.md`, `design-system.md`, `sheets-schema.md`.

## Common commands

```sh
npm run dev          # local dev server on :3000
npm run typecheck    # tsc --noEmit
npm run lint
npm run build
npm run test         # vitest run
npm run snapshot:local  # dry-run the Postgres → Blob pipeline locally
```

Slash commands available in Claude Code:

- `/snapshot` — guided pipeline run + sanity checks
- `/sync-sheet` — diff Sheets headers vs `lib/sheets/schemas.ts`
- `/assign` — quick assignment from chat
- `/deploy` — pre-deploy checklist

## Modular rules

Read these on tasks that touch the relevant area:

- `.claude/rules/data-privacy.md` — **the hard rule**: production data never flows through AI
- `.claude/rules/code-style.md` — TypeScript / Python / SQL conventions
- `.claude/rules/sheets-integration.md` — atomic writes, schema enforcement, race conditions
- `.claude/rules/snapshot-conventions.md` — query patterns, Cell field meanings, indexing notes
- `.claude/rules/testing.md` — what we test and don't

## What this dashboard isn't (in v1)

- Not a CRM. No customer-facing surface.
- Not a notification system. No Slack/email pings.
- Not a CMS for ship metadata. Postgres owns ships/voyages/silver.
- Not an audit trail UI. Audit log is append-only and not surfaced to users.

## Phase pointer

Currently at the start of **Phase 1** — Postgres → Blob snapshot pipeline. The seven Phase-0 push-back questions are resolved (see `docs/plan.md` "Decisions"), including the silver QA counts on `Cell` (`dt`, `dd`, `sp`, `ol`).
