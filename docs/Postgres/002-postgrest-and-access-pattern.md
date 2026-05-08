# 002 — PostgREST and access pattern

**Status:** Accepted

## Context

The application uses `@supabase/supabase-js`'s `.from('table').select()` query builder pervasively — **246 callsites** across the codebase. Under the hood, that builder is a thin wrapper around HTTP requests to **PostgREST**, the open-source REST-over-Postgres service that Supabase hosts as part of its managed offering.

Azure Database for PostgreSQL Flexible Server does not ship with PostgREST. We must decide what those 246 callsites talk to after migration.

A second question hides inside the first: **is the browser allowed to talk to PostgREST directly, the way it talks to Supabase today?** The audit showed that today, the browser sends 9 `.from('user_profiles')` calls directly to Supabase's PostgREST endpoint; everything else (214 callsites) is on the server side, through the Express backend.

## Decision

**Self-host PostgREST as a Container App with internal-only ingress, and route 100% of database traffic through the Express backend.**

### Server-side (backend)

- Continue to use `@supabase/supabase-js` in the backend — all 214 backend callsites stay verbatim.
- The client is configured with `SUPABASE_URL = https://postgrest.internal.<cae-domain>` and a service-role JWT consumed by PostgREST.
- This keeps maintainability high: when upstream changes land in the OSS project this app is forked from, we can merge them as one-file diffs rather than reconciling 214 query rewrites.

### Browser-side (frontend)

- The 9 direct-to-Supabase callsites in `frontend/src/contexts/UserProfileContext.tsx` (8) and `frontend/src/app/signup/page.tsx` (1) are **refactored to call the Express backend** instead. These are all reads/writes against `user_profiles`. The backend already exposes `/user/profile` (`mikeApi.ts:51`); we extend that surface to cover the remaining operations.
- After this refactor, the browser **never talks to PostgREST or Postgres**. The blast radius of any DB-side misconfiguration is bounded by the backend's authorization layer.
- Auth-related Supabase calls in the browser (`supabase.auth.getSession()`, `signInWithPassword()`, etc.) are out of scope here — they are handled by the EntraID work.

### Why we did not switch off PostgREST entirely

If the browser is no longer talking to PostgREST, a reasonable question is whether to drop PostgREST and have the backend talk to Postgres directly via a low-level driver (`pg`). We did not, because:

1. **Maintainability.** The 214 backend callsites would all have to be rewritten. The application is a fork that tracks an OSS upstream; rewriting hundreds of files would make every future merge painful.
2. **PostgREST is operationally cheap.** A stateless container that scales to zero. The only real cost is one Container App.
3. **Optionality.** Should we ever decide to expose a curated subset of tables to the browser again (with strict RLS), the layer is already in place.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. Self-host PostgREST, internal-only, browser refactored** *(chosen)* | Preserves 214 callsites verbatim. No public DB surface. RLS no longer load-bearing. | One file refactor (~9 callsites). One extra container to operate. |
| **B. Self-host PostgREST publicly, browser keeps direct access** | Zero application code change. | PostgREST becomes load-bearing for security; full RLS coverage required across the schema; JWT validation pipeline tied to EntraID becomes critical-path. |
| **C. Drop PostgREST entirely, switch backend to `pg` or an ORM** | One fewer service. Simpler topology. | 214 backend callsites rewritten. Every upstream merge becomes a manual reconciliation. |

## Consequences

- **PostgREST is internal-only.** The Container App's `ingress.external` is `false`. There is no public FQDN and no path from the internet that resolves the service.
- **The 9-callsite frontend refactor is mechanical.** It happens in one PR alongside the backend endpoint additions:
  - `GET /user/profile` (already exists; extend response shape if needed)
  - `PATCH /user/profile`
  - `POST /user/profile/api-keys` (or whatever shape the credit / tier / API-key fields require)
  - Any other operations currently in `UserProfileContext.tsx`
- **`backend/src/lib/supabase.ts` changes one line** — `SUPABASE_URL` points at the internal PostgREST DNS. The frontend's `frontend/src/lib/supabase.ts` continues to exist for the auth flow; that file is rewritten by the EntraID agent.
- **The PostgREST JWT secret** is set once during provisioning, lives in Key Vault, consumed by both the PostgREST app (as `PGRST_JWT_SECRET`) and the backend (so it can mint service-role-style tokens). The EntraID work replaces this with a JWKS URL pointing at the EntraID tenant.
- **RLS becomes optional.** With no untrusted client talking to PostgREST, RLS is no longer a security boundary. The existing two policies on `user_profiles` can be removed (the EntraID agent will own this decision); authorization is enforced in `backend/src/lib/access.ts` and equivalents.
- **No PostgREST upgrade is automatic.** We pin a version (`v12.2.x`) and update on a manual cadence. See `../infra/005-container-images-and-observability.md`.

## Deferred to the EntraID work

- The PostgREST JWT signing key vs JWKS-from-EntraID swap.
- Removing the two RLS policies on `user_profiles` (they currently reference `auth.uid()`, which has no meaning on Azure Postgres).
- Removing the `auth.users` FK and `on_auth_user_created` trigger; replacing them with application-level profile creation.
