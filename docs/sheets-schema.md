# Google Sheets schema

Single workbook. Three tabs. Service account does all writes — clients never talk to Sheets directly.

## `assignments`

| Column | Type | Notes |
|---|---|---|
| `assignment_id` | string (UUID) | Generated client-side before write. **Never derived from row number.** |
| `created_at` | ISO datetime | Service-account stamp |
| `created_by` | slug | from `team_config.slug` |
| `ship_mmsi` | integer | |
| `ship_name` | string | Denormalised from `ships.display_name` for human reading |
| `cruise_line` | string | Denormalised |
| `date_start` | YYYY-MM-DD | |
| `date_end` | YYYY-MM-DD | Inclusive |
| `assignee` | slug | `team_config.slug` |
| `status` | enum | `queued` \| `in_progress` \| `done` \| `blocked` |
| `notes` | string | Append-only. Each entry prefixed `[author @ ISO]\n` |
| `updated_at` | ISO datetime | |
| `updated_by` | slug | |

**Status transitions.** Cleaners may move `queued ↔ in_progress`, `in_progress → done`, `→ blocked`. `done` is terminal until an assigner reopens.

## `team_config`

| Column | Notes |
|---|---|
| `slug` | Primary key, e.g. `angus`, `mon`, `bea` |
| `display_name` | UI label |
| `google_email` | Used in NextAuth `signIn` callback |
| `db_user_id` | FK to Postgres `users.id` for `silver.updated_by` lookups |
| `role` | `assigner` \| `cleaner` \| `viewer` |
| `active` | Boolean — soft-delete by setting false |

Adding a teammate is a row insert here. No deploy.

## `audit_log` (append-only)

| Column | Notes |
|---|---|
| `ts` | ISO datetime |
| `actor` | slug |
| `action` | `create` \| `update` \| `delete` |
| `assignment_id` | UUID |
| `field` | column name, or `*` on create/delete |
| `before` | string |
| `after` | string |

## Write rules

- Use `spreadsheets.values.append` with `INSERT_ROWS` for new rows. Never `update` for new rows.
- Every assignment write triggers a parallel `audit_log` append. If audit fails, log it but don't fail the user request.
- Header row checked against `lib/sheets/schemas.ts` once per day; mismatch surfaces as a setup error to assigners only.
- Positional reads break silently if columns reorder — `/sync-sheet` slash command flags drift.
