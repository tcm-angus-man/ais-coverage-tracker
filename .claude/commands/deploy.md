---
description: Pre-deploy checklist for ais-coverage-tracker
---

# /deploy

Run before merging to `main`. Vercel deploys from the GitHub push — this command only validates locally; it does **not** invoke `vercel --prod`.

## Steps

1. Confirm current branch and target — never deploy from anything but `main` for production.
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test`
5. `git status` and `git diff main...HEAD` — show the user what's about to ship.
6. Scan the diff for sensitive paths:
   - `.env` / `.env.*`
   - `service-account*.json`
   - `*.key`, `*.pem`
   - Inlined Postgres connection strings
   - Hard-coded `@thecruisemaps.com` user records (the hardcoded stub team in `lib/sheets/team-config.ts` is OK in Phase 0–1; flag once Phase 2 is live)
7. Flag any new dependencies added.
8. `npm run build` locally — must pass.
9. If everything passes, the user can `git push`. Vercel handles the deploy. Report the preview URL once Vercel reports it.

## Hard rules

- Never run `vercel --prod` directly.
- Never `git push` without explicit confirmation.
- Never `git push --force` on `main`.
- If any check fails, stop and surface it — do not patch the issue silently and continue.
