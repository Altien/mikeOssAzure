## Status

**Implemented 2026-05-05** — code-complete, not yet verified against a deployed `authProvider=entra` environment. The dev RG was provisioned with `authProvider=supabase` and is unaffected.

The implementation **deliberately deviates from the original spec**: instead of switching PostgREST from HMAC to JWKS validation, it removes JWT validation from the backend → PostgREST path entirely in entra mode. See "Architectural reconsideration" below for the reasoning. The original-spec JWKS approach was implemented first (commit `455e429`) and superseded by this simpler model.

What ships:

- `infra/modules/containerapp-postgrest.bicep` takes a single `authProvider` parameter. In entra mode it drops the `pgrst-jwt-secret` Key Vault secret reference and sets no `PGRST_JWT_*` env vars at all — PostgREST runs without JWT validation. `PGRST_DB_ANON_ROLE` is `service_role` in entra mode, `web_anon` in supabase/local mode.
- `backend/src/lib/supabase.ts` no longer acquires a Managed Identity token for PostgREST in entra mode. Its `createServerSupabase()` returns a supabase-js client with a fetch wrapper that **strips** Authorization and apikey headers — supabase-js would otherwise inject them, and PostgREST refuses requests carrying an Authorization header when no `jwt-secret` is configured.
- `infra/main.bicep` plumbs `authProvider` through; previously hardcoded `'supabase'` on the backend module. The unused `entraTenantId` and `entraBackendClientId` params from the JWKS attempt have been removed.

Pre-existing infra bug fixed as part of this work:

- `containerapp-backend.bicep` and `containerapp-job-migrate.bicep` were using `if () { ... }` inside `secrets:` and `env:` array literals. That syntax has never been valid Bicep — the modules failed `az bicep build`. Any redeploy from `main` would have failed before this fix. Replaced with `var` + ternary + `concat()`.

## Architectural reconsideration

The original spec — JWKS validation between backend and PostgREST — would have removed the shared HMAC secret but kept the JWT-validation layer in place. After review, the JWT layer turned out to be paying for almost nothing in our deployment:

1. PostgREST has `external: false` ingress. Only the backend's Container App can reach it.
2. Postgres has a private endpoint. Only PostgREST and the migration job can reach it.
3. We had explicitly decided to not implement per-user RLS yet — `PGRST_DB_ANON_ROLE` was pinned to `service_role` so that **every** valid JWT got the same Postgres role.

In that configuration, the `aud` check on the JWT was filtering out Entra tokens issued for other audiences in the same tenant — but no such token can reach PostgREST anyway, because the network won't allow it. The validation step was theatre.

The simpler shape we shipped:

- Backend has a single trusted identity (the Container App's Managed Identity). It is the only thing that can reach PostgREST.
- PostgREST trusts whoever can reach it on the internal network. No JWT, no HMAC, no JWKS.
- The migration job continues to talk directly to Postgres with its MI token (issue 015) — that path is unchanged.
- Application code (`createServerSupabase()`) is the seam. Routes call it, get a working client, and never see the words "role" or "JWT" in a database context.

When per-user authorization comes back as a real requirement — the **Entra group → Postgres role** ticket tracked in `docs/azure-production-hardening.md` — JWT validation re-enters the architecture, but at that point it's doing meaningful work: forwarding the user's token, validating its signature against Microsoft's JWKS, and mapping `groups` claims to per-tenant Postgres roles for RLS-backed row-level filtering. Until then, the backend's `checkProjectAccess` / `ensureDocAccess` helpers remain the access-control authority and DB-level RLS is not in play.

## Spec deviations

| Original spec | What ships | Why |
|---|---|---|
| `PGRST_JWT_SECRET=@<jwks-url>` + `PGRST_JWT_AUDIENCE` | No `PGRST_JWT_*` vars in entra mode | JWT validation isn't doing useful work without per-user RLS — see "Architectural reconsideration" |
| Backend acquires MI token, forwards as bearer | Backend strips Authorization headers; sends nothing | Same reason — there's nothing to validate |
| `postgrest-jwt-secret` removed from Key Vault in entra mode | Same — secret not referenced when `authProvider=entra` | ✓ |
| `SUPABASE_SECRET_KEY` env var absent on backend in entra mode | Same — backend module does not mount this secret when `authProvider=entra` | ✓ |
| Supabase mode unaffected | ✓ — HMAC + role-claim path preserved | Required for OSS / single-tenant + local Docker stack |

## Parent docs

`docs/Postgres/002-postgrest-and-access-pattern.md`
`docs/Postgres/004-entraid-handoff.md` (item 5)
`docs/infra/003-secrets-and-identity.md`

## What to build

Replace the shared HMAC `PGRST_JWT_SECRET` used by PostgREST with JWKS-based validation against the Entra tenant. The backend stops minting its own service-role JWTs and instead passes its Managed Identity token when calling PostgREST internally.

### Why this matters

Currently: `PGRST_JWT_SECRET` is a shared HMAC secret. The backend mints tokens signed with this secret; PostgREST validates them. In Entra mode, PostgREST should validate the same Entra-issued tokens that the backend already validates — no separate secret to rotate.

### PostgREST configuration change

Replace env var on the PostgREST Container App:

```
# Remove:
PGRST_JWT_SECRET=<hmac-secret>

# Add:
PGRST_JWT_SECRET_IS_BASE64=false
PGRST_JWT_JWKS_URI=https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys
PGRST_JWT_AUDIENCE=<ENTRA_BACKEND_CLIENT_ID>
```

PostgREST v12.2.x supports `PGRST_JWT_JWKS_URI` for JWKS-based validation. Confirm the exact env var name against the PostgREST v12.2.x release notes before implementation.

Update `infra/modules/containerapp-postgrest.bicep`: replace the KV reference for `postgrest-jwt-secret` with plain env vars for `PGRST_JWT_JWKS_URI` and `PGRST_JWT_AUDIENCE`. Remove the `postgrest-jwt-secret` Key Vault secret slot.

### Backend token acquisition for PostgREST calls

The backend currently calls PostgREST (via `@supabase/supabase-js` client pointed at the internal URL) using a service-role JWT it mints with the shared HMAC secret.

Replace with Managed Identity token acquisition:

```typescript
// backend/src/lib/supabase.ts
import { DefaultAzureCredential } from '@azure/identity';

const credential = new DefaultAzureCredential();

export function createServerSupabase() {
  if (process.env.AUTH_PROVIDER === 'entra') {
    // Acquire an MI token for the backend API scope
    const token = await credential.getToken(process.env.ENTRA_BACKEND_SCOPE!);
    return createClient(process.env.SUPABASE_URL!, token.token, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token.token}` } },
    });
  }
  // Supabase mode: existing path unchanged
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
}
```

Token should be cached and refreshed before expiry (use `DefaultAzureCredential` caching — it handles this).

### Key Vault cleanup

Remove `postgrest-jwt-secret` from Key Vault and the Bicep template once JWKS validation is confirmed working in staging.

## Acceptance criteria

- [x] **Bicep**: PostgREST module takes a single `authProvider` parameter and conditionally drops JWT validation in entra mode.
- [x] **Bicep**: backend module no longer mounts `supabase-secret-key` / `SUPABASE_SECRET_KEY` when `authProvider=entra`.
- [x] **Bicep**: `pgrst-jwt-secret` Key Vault reference dropped from PostgREST in entra mode (still present in supabase mode where it's needed).
- [x] **Bicep**: `az bicep build infra/main.bicep` is clean (was failing before this work due to the `if () { ... }` syntax bug).
- [x] **Backend**: `createServerSupabase()` strips Authorization / apikey headers in entra mode so PostgREST treats every request as anonymous → service_role.
- [x] **Local dev / supabase mode unaffected** — HMAC path preserved for `authProvider != 'entra'`.
- [ ] **Verified end-to-end against a live `authProvider=entra` deployment** — pending, no entra environment provisioned yet.
- [ ] **Per-user / per-group DB authorization** — out of scope for 014 by design. Tracked as the "Entra group → Postgres role mapping" follow-up in `docs/azure-production-hardening.md`. Until that lands, every backend query in entra mode runs as `service_role` and DB-level RLS is not in play; the backend's `checkProjectAccess` / `ensureDocAccess` helpers remain the access-control authority.

The "verify against live entra deployment" item is covered by whichever follow-up ticket stands up the first entra environment.

## Blocked by

- `009-backend-entra-jwt-validation.md` (Entra tokens must be validated by the backend before we can trust they work end-to-end through PostgREST too)
- `013-frontend-msal-auth-provider.md` (Entra token flow must be complete end-to-end before we can verify PostgREST validates them correctly)

## User stories addressed

- No shared secret needs to be rotated to refresh PostgREST security; it uses the same tenant JWKS as the backend.
- The `postgrest-jwt-secret` Key Vault secret and its management overhead are eliminated.
