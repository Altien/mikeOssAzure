# Agent handoff — 2026-05-05

Branch: `codex/local-first-upstream-planning`
Status: **ready to PR into `main`** after local Entra login was validated.

---

## Current mini-sprint summary

Goal: get this fork developing and validating locally with the Node backend on `localhost:3001`, frontend on `localhost:3000`, local Docker data services, and a working Entra login path.

Important principle added to `AGENTS.md`: keep changes small and upstream-compatible because we want to continue taking changes from the source OSS repo and extract clean upstream PRs where possible.

## New commits on `codex/local-first-upstream-planning`

| Commit | What |
|---|---|
| `213bf33` | Added local-first, upstream-compatible migration strategy docs and issue files. |
| `150c396` | Added local frontend auth client boundary and local login path. |
| `83c77c0` | Ignored local `.agents/` tooling. |
| `8baaf46` | Clarified that current `supabase-js` usage is a PostgREST compatibility boundary, not a hosted Supabase commitment. |
| `bb1fc3f` | Added `scripts/dev-infra-check.ps1` for local Docker/PostgREST/Azurite checks. |
| `e5e38ce` | Added backend-driven Entra login flow based on MatterAI's provider-selection pattern. |

## Docs added or updated

| File | Purpose |
|---|---|
| `docs/local-first-upstream-strategy.md` | Strategy for local-first validation and upstream-compatible refactoring. |
| `docs/auth-provider-selection-flow.md` | Design note for the MatterAI-style backend provider selection and Entra callback flow. |
| `docs/runbook-entra-local-auth.md` | Step-by-step Entra app-registration setup and local validation runbook. |
| `docs/issues/azure-migration/017-local-first-auth-boundary.md` | Local-first auth boundary issue. |
| `docs/issues/azure-migration/018-frontend-api-token-boundary.md` | Frontend token/API boundary issue. |
| `docs/issues/azure-migration/019-frontend-hosted-dependency-isolation.md` | Hosted dependency isolation issue. |
| `docs/issues/azure-migration/020-azure-blob-storage-first.md` | Azure Blob/Azurite-first issue. |
| `docs/issues/azure-migration/021-backend-postgrest-client-boundary.md` | Backend PostgREST client boundary issue. |

## Validated locally this mini-sprint

- Backend compile:

```powershell
cd C:\Data\Projects\MikeAzureDev\backend
npm run build
```

- Frontend compile:

```powershell
cd C:\Data\Projects\MikeAzureDev\frontend
npm run build
```

- Local Docker data plane check:

```powershell
.\scripts\dev-infra-check.ps1
```

- Backend health endpoint:

```text
http://localhost:3001/health
```

- Microsoft Entra login:
  - Frontend at `http://localhost:3000/login`.
  - Login redirects to backend `/auth/select-provider`.
  - Backend redirects to Microsoft.
  - User successfully authenticated and returned to the app.

## What we learned

- The backend has no root route. `http://localhost:3001/` is not the right health test; use `/health`.
- Azure Container Apps should not be the first validation loop. Local Node, frontend, Docker Postgres/PostgREST/Caddy/Azurite, and Entra should work first.
- MatterAI's auth shape is useful: provider selection and OpenID callback should be backend-owned.
- This repo currently uses browser-held bearer tokens for API calls, unlike MatterAI's backend session-cookie model. We preserved that contract to keep the change small.
- The Entra access token must be for the backend API scope. The backend validator checks `aud` against `ENTRA_BACKEND_CLIENT_ID`.
- The local Web/Login app registration needs a Web redirect URI at `http://localhost:3001/auth/openid-callback/microsoft`.
- Google should not be exposed in this repo yet. MatterAI can show Google because it bridges providers into backend sessions; this repo would need a Google validator or session bridge first.
- Frontend builds still need `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` even in Entra mode because some upstream-shaped pages import the Supabase client during prerender.
- Backend `supabase-js` is currently a PostgREST client boundary. Remove it only after data access is isolated.

## Current local env state

`backend/.env` and `frontend/.env.local` contain local Entra values and secrets and are ignored by git. Do not commit them.

Required backend values:

```env
AUTH_PROVIDER=entra
FRONTEND_URL=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:3001
ENTRA_TENANT_ID=<tenant-id>
ENTRA_BACKEND_CLIENT_ID=<backend-api-client-id>
ENTRA_CLIENT_ID=<web-login-client-id>
ENTRA_CLIENT_SECRET=<web-login-client-secret-value>
ENTRA_BACKEND_SCOPE=api://<backend-api-client-id>/access_as_user
ENTRA_REDIRECT_URI=http://localhost:3001/auth/openid-callback/microsoft
AUTH_STATE_SECRET=<strong-random-string>
```

Required frontend values:

```env
NEXT_PUBLIC_AUTH_PROVIDER=entra
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_ENTRA_CLIENT_ID=<web-login-client-id>
NEXT_PUBLIC_ENTRA_TENANT_ID=<tenant-id>
NEXT_PUBLIC_ENTRA_BACKEND_SCOPE=api://<backend-api-client-id>/access_as_user
NEXT_PUBLIC_REDIRECT_URI=http://localhost:3000/login
NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=local-dev-key
```

## Recommended next steps after merging this PR

1. Re-check local Entra login from a clean `main`.
2. Exercise authenticated frontend flows against the Node backend.
3. Isolate remaining frontend Supabase imports so Entra/local mode does not need Supabase browser env.
4. Continue backend PostgREST client isolation before removing `supabase-js`.
5. Decide whether to keep browser bearer-token auth or move toward a MatterAI-style backend session-cookie bridge.

---

## Historical handoff from earlier Azure-local-stack work

Branch: `claude/issue-seven-0SuI1`
Status at that time: **ready to PR into `main`**, then continue auth/code track.

## What was done in that earlier session

| Commit | What |
|---|---|
| `6138322` feat(ci/007) | `.github/workflows/deploy.yml` — OIDC build → migrate → promote pipeline. `scripts/setup-github-oidc.sh` — idempotent SP + federated credential bootstrap. |
| `b1e4c2d` feat(local-stack) | `docker-compose.dev.yml` (Postgres 16 + PostgREST v12.2.3 + Caddy + Azurite). Role-bootstrap SQL. HS256 JWT minter. |
| `581c3a8` feat(008.0) | `backend/src/lib/auth/providers/local.ts` — stdlib HS256 verifier. `middleware/auth.ts` wired to `AUTH_PROVIDER=local`. `service_role` Postgres role + full local runbook. |
| `a27fe40` fix(local-stack) | Corrections from the desktop test run (JWT_SECRET timing, Azurite shorthand, npx migrate, route paths). |

---

## Verified working on desktop (2026-05-05)

Full stack: Postgres 16 + PostgREST + Caddy proxy + Azurite (pre-existing) + backend `npm run dev`.

```
GET  /health             → {"ok":true}
GET  /projects           → []                 (authenticated, empty)
POST /projects           → {id, name, ...}    (row in local Postgres)
```

Auth path: forged HS256 JWT → `validateLocalToken` → `requireAuth` → supabase-js → Caddy :8000 `/rest/v1/*` → PostgREST :4000 → Postgres.  
Storage: `UseDevelopmentStorage=true` → Azurite :10000, container `documents` confirmed created.

---

## Desktop run gotchas (already fixed in runbook)

1. **`JWT_SECRET` must be exported before `docker compose up`** — PostgREST reads it at container start, not from `.env`. If missed, restart PostgREST with `--force-recreate`.
2. **If Azurite already running**, start only `postgres postgrest caddy` to avoid port conflict.
3. **Azurite container creation**: use Node SDK + `UseDevelopmentStorage=true`, not `az storage container create` (az CLI picks up real Azure account).
4. **`npm run migrate` fails on Windows PATH** — use `npx node-pg-migrate up --migrations-dir migrations --migration-file-language sql`.
5. **Backend routes have no `/api` prefix**: `/projects`, `/chat`, `/user`, etc.

---

## What is NOT done yet

### 007 — CI/CD pipeline

The workflow file is written and pushed. It has **not yet run against Azure**. To activate:

1. Run `scripts/setup-github-oidc.sh dev altien/MikeAzureDev` — creates `gh-mike-cicd-dev` SP, wires OIDC federation.
2. Set repo variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (printed by the script).
3. Trigger: GitHub UI → Actions → "deploy" → Run workflow → environment: dev.
4. Or merge this branch to `main` and push a backend change.

### 008 — Auth provider abstraction (partial)

- `local` provider ✅ (this session)
- `entra` provider ❌ (issue 009 — JWKS validation against Entra tenant)
- Supabase-to-PostgREST data layer still using `supabase-js`; post-013 that gets refactored away

### 009–014 — Auth/code track (not started)

Dependency order:

```
009 (Entra JWT) → 010 (tenant/group enforcement) → 011 (user bootstrap)
011 → 012 (frontend PostgREST → backend)
009 + 012 → 013 (MSAL frontend auth)
009 + 013 → 014 (PostgREST JWKS)
```

All of these are testable against the local stack once 009 lands.

---

## Recommended next issues (in order)

### Option A — close the CI loop first (low risk, high confidence)
1. PR `claude/issue-seven-0SuI1` → `main`.
2. Wire the OIDC federation (one `scripts/setup-github-oidc.sh dev ...` run from a machine with Azure access).
3. Trigger the workflow, verify image appears in ACR, migration runs, backend promotes.
4. Then start 009.

### Option B — press on with 009 (faster to working login)
1. PR this branch.
2. Start 009 on a new branch: `validateEntraToken` provider — JWKS fetch from `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, validate RS256, extract `oid` → `userId`, `tid`, `groups`.
3. Wire `AUTH_PROVIDER=entra` in `middleware/auth.ts`.
4. Test locally with a real Entra-issued access token (or mock JWKS for unit tests).
5. 010 follows immediately (tenant/group middleware, testable against local stack with Entra tokens or forged claims).

**Recommendation: Option A first** — one clean pipeline run against dev proves the whole deploy chain, and then 009 can land with confidence that the CI/CD vehicle is verified.

---

## Key file index

| Purpose | File |
|---|---|
| Issue index + status | `docs/issues/azure-migration/README.md` |
| CI/CD pipeline | `.github/workflows/deploy.yml` |
| OIDC bootstrap script | `scripts/setup-github-oidc.sh` |
| CI/CD plan | `docs/issues/azure-migration/007-implementation-plan.md` |
| Local stack compose | `docker-compose.dev.yml` |
| Local stack runbook | `docs/runbook-local-stack.md` |
| Local auth plan | `docs/issues/azure-migration/008.0-local-auth-provider.md` |
| Local auth provider | `backend/src/lib/auth/providers/local.ts` |
| Auth middleware | `backend/src/middleware/auth.ts` |
| Role bootstrap SQL | `scripts/local-stack/00-init-roles.sql` |
| JWT minter | `scripts/local-stack/forge-jwt.mjs` |
| Caddy config | `scripts/local-stack/Caddyfile` |
| Backend env template | `backend/.env.example` |
| Azure dev runbook | `docs/runbook-dev-deployment.md` |

---

## Secrets / env in use (never commit)

| Variable | Where | Value pattern |
|---|---|---|
| `JWT_SECRET` | `backend/.env`, exported to shell | 36-byte base64, shared with PostgREST |
| `SUPABASE_SECRET_KEY` | `backend/.env` | HS256 JWT, `role=service_role`, 10-yr expiry, signed with `JWT_SECRET` |
| `AZURE_CLIENT_ID` etc. | GitHub repo variables (not secrets) | Set by `setup-github-oidc.sh` |
| `pgAdminPassword` | Never stored, passed at Bicep deploy time | In Key Vault as `postgres-admin-password` |

`backend/.env` is in `.gitignore`. Do not commit it.
