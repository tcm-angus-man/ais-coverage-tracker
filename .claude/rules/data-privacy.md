# Data privacy — the hard rule

**Production data never flows through the AI.** No exceptions, no edge cases, no "just this once because it's faster".

## What this means in practice

- Do not read `tmp/snapshot.json`, `*.snapshot.json`, `mock-coverage*.json`, or anything in `tmp/` or `scratch/`. These are blocked in `.claude/settings.json`.
- Do not ask the user to paste query results, snapshot rows, or sheet contents into chat. If they're about to do it themselves, push back.
- Do not echo the contents of `.env`, `.env.*`, `service-account*.json`, `*.key`, or `*.pem`.
- Do not run `psql`, `pg_dump`, `pg_restore`, or any tool that reads the production database. The database is read-only from this app, but that means **the cron handler reads it; you do not**.
- When debugging, work from `tests/fixtures/snapshot.sql` (synthetic) and the type definitions in `lib/snapshot/types.ts` and `lib/sheets/schemas.ts`.

## Why

PII and operational metadata about cleaning ops are not data we have permission to share with third parties — including AI providers. The team relies on this rule being absolute.

## How to apply

- Operate on shapes, types, and counts — not values.
- If you need to "see what the data looks like" to debug, write a small synthetic fixture that matches the shape, and use that.
- If a task seems to require seeing real data, surface that to the user as a blocker; don't work around it.
