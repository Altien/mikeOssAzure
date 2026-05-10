# Issue 025 — Lock Down or Remove the PostgREST Diagnostics Page

## Goal

Decide the long-term home for `GET /admin/diagnostics/postgrest` — either always-gated with a required token, scoped to a specific environment, or removed.

## Context

Issue 023's debug effort introduced `backend/src/routes/diagnostics.ts`, an HTML diagnostic page that runs eight tests against the deployed PostgREST and supabase-js client and prints raw HTTP detail (status, headers, body) for each.

That page was the diagnostic surface that finally surfaced the `/rest/v1` URL mismatch. It is genuinely useful: any future PostgREST/supabase-js regression can be triaged in one screen instead of guess-deploy cycles.

However:

- The route is registered unconditionally in `backend/src/index.ts`.
- Auth is via `?token=<DIAGNOSTICS_TOKEN env var>`. If `DIAGNOSTICS_TOKEN` is unset, the page is fully open — convenient for the dev environment, dangerous for any other.
- The page reveals: full PostgREST URL, schema cache state, a list of recent migration columns, and demonstrates that INSERT/DELETE roundtrip succeeds against `user_profiles` with no auth. That is a useful information surface for an attacker who reaches the backend.
- Production deployments will run this code path. Operators cannot all be trusted to set `DIAGNOSTICS_TOKEN` themselves.

## What to decide

Pick one of these options before any production rollout:

### Option A — Always-required token

- Remove the "open if no token configured" branch from `checkAuth`.
- Fail closed: no `DIAGNOSTICS_TOKEN` env var → 404 / 403, not "open".
- Document in install configurator (issue 023) that this token is auto-provisioned during install.

### Option B — Environment-gated

- Only register the route when `process.env.NODE_ENV !== "production"` or a similar dev-only flag.
- Risk: dev tools tend to silently slip into prod when an env var goes wrong.

### Option C — Remove

- Drop `backend/src/routes/diagnostics.ts` and the `/admin/diagnostics` route registration.
- Keep the file in `git log` as a reference for future debug pages.
- If we want it later, we can resurrect from history.

Recommendation: **Option A**, on the grounds that the page genuinely helps when something breaks in production and a fail-closed token gate is cheap to maintain.

## Acceptance criteria

- [ ] The diagnostics page is not reachable without explicit auth in any environment.
- [ ] Default behavior on a fresh deployment is "page does not respond" until the operator explicitly enables it.
- [ ] If the page is kept, install configurator (issue 023) covers token provisioning.
- [ ] If the page is removed, `backend/src/index.ts` and `backend/src/routes/diagnostics.ts` are cleaned up.

## Out of scope

- Building additional diagnostic pages (auth, storage, blob, etc.). Future tickets if they're needed.

## Dependencies

- 023 (install configurator) if Option A is chosen — token needs to be auto-provisioned.
