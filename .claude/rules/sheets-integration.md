# Sheets integration

The Google Sheets workbook is the mutable team layer. Three tabs: `assignments`, `team_config`, `audit_log`. See `docs/sheets-schema.md` for column definitions.

## Atomicity and IDs

- **`assignment_id` is a UUID generated client-side before the API call.** Never derive an ID from row number — Sheets row numbers are not stable under concurrent writes.
- The service account does all writes. The browser never talks to Sheets directly. There is no Sheets API key in the client bundle.
- Use `spreadsheets.values.append` with `valueInputOption: 'USER_ENTERED'` and `insertDataOption: 'INSERT_ROWS'` for new rows. **Never `update` for new rows** — that races on the next available row.
- Reads use `spreadsheets.values.get`. Cache `team_config` reads with `unstable_cache` (TTL ~60s) — it changes rarely.

## Audit logging

- Every assignment write triggers a parallel `audit_log` append.
- If the audit append fails, log the failure server-side but **don't fail the user request**. The assignment write is the source of truth; audit is best-effort observability.
- Audit fields: `ts`, `actor`, `action` (`create` | `update` | `delete`), `assignment_id`, `field` (column name or `*`), `before`, `after`.

## Schema enforcement

- `lib/sheets/schemas.ts` defines the canonical column order for each tab.
- A daily startup check reads header row 1 of each tab and compares to the schema. Mismatch surfaces a setup error visible to assigners only — not cleaners.
- The `/sync-sheet` slash command runs this check on demand.

## Race conditions

- Two assigners can write to the same cell range simultaneously without conflict — Sheets `append` always finds a fresh row.
- Concurrent updates to the **same** assignment (PATCH on the same `assignment_id`) use last-write-wins. Acceptable for v1; Phase 7 may add ETags.

## What to never do

- Never write Sheets credentials into client-bundled code.
- Never derive identity (assignee, created_by) from the request body — always from the server-side session.
- Never `clear` or `delete` rows. Soft-delete by setting `status='blocked'` plus a notes entry.
