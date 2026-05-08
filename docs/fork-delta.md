# Fork delta — files diverged from upstream

Every file listed here has been modified or added relative to the
upstream Mike repository. Keeping this list current makes it easy to
rebase onto future upstream releases: resolve only the files listed
here; everything else can be accepted as-is.

The fork sticks to two layers:

- **Provider-boundary refactors** — pure refactors with no Azure
  dependency, intended to ease accepting upstream changes around the
  same provider points. Suitable for upstream PRs.
- **Azure / Entra / local-stack additions** — application code that
  makes the fork run end-to-end on Azure (or locally without any
  hosted dependency). The substance of this fork.

---

## Provider-boundary refactors

These changes introduce no Azure dependency and make the codebase
more extensible for any deployment.

| File | Nature of change |
|---|---|
| `backend/src/lib/storage.ts` | Refactored hardcoded R2 functions to `StorageProvider` interface + `R2Provider` class + `createProvider()` factory. Zero behaviour change for R2 deployments. |
| `backend/src/lib/auth/types.ts` | New file — provider-neutral `AuthPrincipal` and `AuthValidationResult` types. |
| `backend/src/lib/auth/providers/supabase.ts` | New file — Supabase validation logic extracted from middleware into a standalone provider function. |
| `backend/src/middleware/auth.ts` | Refactored to provider dispatch via `AUTH_PROVIDER` env var; `res.locals.principal` added. Zero behaviour change when `AUTH_PROVIDER=supabase` or unset. |

---

## Application code (Azure adapters, Entra, local stack)

### Provider implementations

| File | Nature of change |
|---|---|
| `backend/src/lib/storage.ts` (Azure sections) | `AzureBlobProvider` class + Azure SDK imports + `createProvider()` Azure branch. |
| `backend/src/lib/auth/providers/entra.ts` | Entra JWT validator: JWKS lookup, issuer/audience/tenant/expiry checks, group extraction. |
| `backend/src/lib/auth/providers/local.ts` | Local HS256 JWT validator for Docker/PostgREST development. |
| `backend/src/lib/auth/roles.ts` | Maps Entra group OIDs to app roles via `ENTRA_*_GROUP_IDS` env vars. |
| `backend/src/middleware/tenantAccess.ts` | Entra-only tenant lifecycle middleware (only runs when `AUTH_PROVIDER=entra`). |
| `backend/src/middleware/requireRole.ts` | Tiny role-guard helper. |

### LLM adapters

| File | Nature of change |
|---|---|
| `backend/src/lib/llm/openai.ts` | OpenAI streaming + completion adapter. |
| `backend/src/lib/llm/azureOpenai.ts` | Azure OpenAI adapter (endpoint + apiVersion + deployment). |
| `backend/src/lib/llm/azureOpenaiDeployments.ts` | Lists deployments configured against the user's AOAI resource for the model picker. |
| `backend/src/lib/llm/{models,types,index}.ts` | Adds `azureOpenai` provider type, `aoai:<deployment>` prefix routing, and the OpenAI tier IDs. |

### Runtime config (tenant-portable bundle)

| File | Nature of change |
|---|---|
| `backend/src/routes/config.ts` | New — `GET /config` returns `{ authProvider, entra: { tenantId, clientId } }` from server env / Key Vault. Replaces build-time `NEXT_PUBLIC_*` baking; the bundle is now tenant-portable. |
| `backend/src/routes/auth.ts` | Adds `GET /auth/logout` — server-constructed Microsoft logout URL so the browser bundle does not need to know the tenant ID. |
| `frontend/src/contexts/ConfigContext.tsx` | New — `ConfigProvider`, `useConfig()`, `getCachedAuthProvider()`. Fetches `/config` on mount and caches the resolved provider in `localStorage`. |
| `frontend/src/lib/supabase.ts`, `lib/auth.ts`, `lib/supabase-server.ts` | Lazy supabase client construction; non-supabase deployments need no supabase env vars. |
| `frontend/src/lib/auth-token.ts` | Uses `getCachedAuthProvider()` and the lazy supabase factory. |
| `Dockerfile` | `ARG NEXT_PUBLIC_API_BASE_URL` on the frontend-builder stage so the deploy pipeline can target same-origin or split-origin without rebaking the bundle. |

### Application routes / lib

| File | Nature of change |
|---|---|
| `backend/src/routes/auth.ts` | Local login endpoint plus MatterAI-style Entra provider selection and OpenID callback for local validation. |
| `backend/src/routes/install.ts` | `/install` configurator HTML routes + write handlers. The route degrades gracefully when operator scripts (which ship in the deploy package, not the application image) are absent. |
| `backend/src/routes/diagnostics.ts` | `/admin/diagnostics` health-check page. |
| `backend/src/routes/llm.ts` | `/llm/azure-openai/deployments` route used by the model picker. |
| `backend/src/routes/{chat,projects,tabular,user,workflows,documents}.ts` | JSONB containment fixes; replaced `db.auth.admin.listUsers` with `user_profiles` lookup; profile-shape updates for AOAI / fast model. |
| `backend/src/lib/install/{installAuth,manifest,types}.ts` | Install configurator's bootstrap-token + Entra OIDC auth, manifest catalog, types. |
| `backend/src/lib/config.ts` | Key Vault-backed config reader with env-var override + TTL cache. |
| `backend/src/lib/userSettings.ts` | Adds Azure OpenAI per-user settings + global-key fallback chain + `upsertUserProfile`. |
| `backend/src/lib/supabase.ts` | Fetch wrapper that strips the `/rest/v1` prefix supabase-js prepends, so the unmodified client can talk to PostgREST directly. Used in both local and entra modes; entra mode additionally strips Authorization + apikey headers. |
| `backend/src/scripts/runMigrations.ts` | `node-pg-migrate` runner used by the Container App migrate job. |
| `backend/migrations/` | Schema rewritten to remove Supabase extensions; uses `node-pg-migrate` against any Postgres 16+. |
| `backend/.env.example` | Azure env vars added (`AZURE_STORAGE_*`, `DATABASE_URL`, `JWT_SECRET`, `AUTH_PROVIDER` block). |
| `frontend/src/contexts/AuthContext.tsx` | Provider boundary supports Supabase / local / Entra. Switches on `useConfig()` runtime mode; sign-out redirects through `/auth/logout`. |
| `frontend/src/contexts/UserProfileContext.tsx` | Adds AOAI settings + global-key flags + AOAI deployment cache. |
| `frontend/src/app/login/page.tsx` | Login page provider branch for local auth and backend-owned Microsoft login redirect. Reads provider mode from `useConfig()`. |
| `frontend/src/app/(pages)/account/page.tsx` | Reads provider mode from `useConfig()` to gate Entra-only UI. |
| `frontend/src/components/providers.tsx` | Wraps app shell with `ConfigProvider`. |
| `frontend/.env.local.example` | Documents the new minimal shape: `NEXT_PUBLIC_API_BASE_URL` plus optional supabase pair. |

### Local-stack scripts (developer machine)

| File | Nature |
|---|---|
| `scripts/local-stack/{00-init-roles.sql,forge-jwt.mjs}` | Local Postgres role topology + local HS256 service-role JWT minter. |
| `scripts/dev-infra-check.ps1` | Local docker-stack smoke check. |
| `docker-compose.dev.yml` | Local Postgres + PostgREST + Azurite. |
| `Dockerfile`, `.dockerignore` | The bundled-frontend multi-stage build. |

---

## What is NOT in this fork

Deployment infrastructure (Bicep, deploy automation, marketplace
packaging, operator-side install scripts) is intentionally not part of
this repository. See `docs/azure-prereqs.md` for the list of resources
an operator needs to provision before running this code, in prose form.
