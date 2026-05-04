---
description: Quick assignment from chat — drafts the API call, asks for confirmation, then sends
---

# /assign

Create one or more assignments without leaving chat. Useful for quick bulk-assigns when you already know the MMSIs and date ranges.

## Steps

1. Ask the user for: ship MMSIs (or display names), date range (`YYYY-MM-DD..YYYY-MM-DD`), assignee slug, optional notes.
2. Resolve display names → MMSIs via `/api/coverage` ship list (or `lib/sheets/team-config.ts` for assignee).
3. Validate inputs against the same zod schema the API route uses.
4. Draft the POST body for each assignment. Show a summary table to the user.
5. **Wait for explicit confirmation** before sending the requests.
6. POST each to `/api/sheets/assignments` (server enforces role-gating; this command just shapes the request).
7. Report results — created IDs, any failures.

## Hard rules

- Never bypass the API route to write to Sheets directly.
- Never assume the local dev server is running — confirm before sending.
- Never send to a production URL unless the user explicitly says so.
