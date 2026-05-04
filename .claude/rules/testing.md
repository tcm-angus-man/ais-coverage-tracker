# Testing

Vitest. Run with `npm run test`. CI uses a containerised Postgres for the snapshot suite.

## What we test

- **Snapshot SQL** against `tests/fixtures/snapshot.sql` (synthetic data). Verify shape, edge cases (zero-row ships, ships with prints but no silver, date-window boundaries).
- **Zod schemas** for every Sheets tab — valid + invalid rows. Catch positional drift early.
- **API route role gating.** Assigner-only routes reject cleaners. Cleaners can only PATCH assignments where `assignee === session.slug`.
- **API route validation.** Bad UUIDs, bad date formats, bad status enums — all 400.

## What we don't test

- Pixel content of the heatmap canvas. The component is pinned by the existing implementation; we don't have time for a Canvas snapshot harness, and it would brittle anyway.
- Third-party libraries (NextAuth internals, googleapis internals).
- Vercel cron infrastructure — out of scope. A failing cron is observable via stale `generated_at`.
- Visual regression. We're a four-person team using a four-person tool.

## Fixture patterns

- `tests/fixtures/snapshot.sql` — runnable against a fresh Postgres. Idempotent. Includes a few edge cases by design.
- `tests/fixtures/sheets/*.csv` — one file per tab. First row is the header. Drives tests that mock the `googleapis` client.

## When to add a test

- Adding a new API route → add a role-gating test and an input-validation test.
- Adding a new Sheets column → update the schema test.
- Fixing a snapshot bug → add a fixture row that reproduces it.
- Adding UI → no test (we manually verify in the browser, per the project ethos).
