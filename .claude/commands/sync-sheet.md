---
description: Diff Google Sheets header rows against lib/sheets/schemas.ts
---

# /sync-sheet

Detect drift between the live Google Sheets workbook and `lib/sheets/schemas.ts`. Positional reads break silently if columns reorder — this is the canary.

## Steps

1. Read `lib/sheets/schemas.ts` — extract the expected column order for each tab (`assignments`, `team_config`, `audit_log`).
2. Use the service-account client (`lib/sheets/client.ts`) to read **only header row 1** of each tab. Do not read any data rows.
3. Compare column-by-column:
   - **Missing in sheet** — column exists in schema, not in sheet header
   - **Missing in schema** — column exists in sheet, not in schema
   - **Out of order** — both present, different positions (this is the critical one)
4. Report drift in a small table. Suggest the smallest patch — usually a one-line tuple change in `schemas.ts`.
5. **Never apply changes automatically.** The user must confirm.

## Hard rules

- Header row only. Do not read data rows.
- Do not paste sheet contents into chat.
- If the service-account credentials aren't configured, fail clearly — don't try to work around it.
