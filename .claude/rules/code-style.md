# Code style

## TypeScript

- **Server components by default.** `"use client"` only for: the heatmap, modals, charts, anything using `useEffect`/`useState`.
- **No HTML `<form>` elements.** Use `onClick` and `onChange` instead. Submit with explicit fetch calls.
- **No ORMs.** `pg` for Postgres reads, `googleapis` for Sheets writes.
- Strict mode is on — no `any`, no implicit any, no untyped function args.
- Path alias `@/*` maps to repo root. Use it for cross-area imports.

## SQL (in `lib/snapshot/queries.ts`)

- Tagged template literals only. No `.sql` files loaded at runtime.
- **Always parameterised.** `pg` interpolates `$1, $2, ...` for you — never concatenate user-supplied values into SQL strings.
- Aggregate in the database, not in Node. `COUNT(*) FILTER (WHERE ...)` over `array.filter().length`.
- Single-statement `CASE` updates over multiple statements when expressing the same logic.
- Index hints belong as a comment above the query if a non-obvious index is required.

## Python (if any scripts land in `scripts/`)

- Stdlib + pandas + numpy only. **No `holidays` library** — hardcode UK bank holidays as a `frozenset` of `date` objects if needed.
- Type hints on public functions.

## Validation

- `zod` on every API route input. Reject early with `{ ok: false, error: string }` and HTTP 400.
- Never trust client-supplied `role` or `slug` — derive from the session.

## Error responses

- Server: `{ ok: false, error: string }` with appropriate HTTP status.
- Client: surface the `error` string to the user. No silent retries.
