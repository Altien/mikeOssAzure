## Parent docs

`docs/entraId/entra-implementation-deep-dive.md` (Workstream 1, Task 1.3; security baseline)
`docs/entraId/entra-implementation-task-breakdown.md` (Task 1.3)
`docs/AzureMove/azure-migration-proposal.md` (Track A, steps 3–4)

## What to build

Implement the Entra token validator in `backend/src/lib/auth/providers/entra.ts`. When `AUTH_PROVIDER=entra`, the backend validates Entra-issued JWTs, extracts the normalized principal, and populates `res.locals` exactly as the Supabase path does.

### `backend/src/lib/auth/providers/entra.ts`

Use `jose` for OIDC/JWKS validation (no Entra SDK dependency — lightweight, already available or add as a devDependency):

```typescript
export async function validateEntraToken(token: string): Promise<AuthValidationResult>
```

Validation steps (in order):
1. Fetch JWKS from `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys` (cache with TTL; rotate automatically on `jwks_uri` update).
2. Verify signature.
3. Validate claims:
   - `iss` must equal `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0`
   - `aud` must equal `ENTRA_BACKEND_CLIENT_ID` (the backend API app registration's application ID URI or client ID)
   - `tid` must equal `ENTRA_TENANT_ID`
   - `exp` and `nbf` standard checks
4. Extract principal:
   - `userId` = `oid` claim (Entra object ID — stable, unique per user per tenant)
   - `email` = `preferred_username` or `email` claim (claims-first; Graph fallback only if both absent — log a warning, do not call Graph in this slice)
   - `tenantId` = `tid` claim
   - `groups` = `groups` claim array if present; if absent or overage marker (`_claim_names.groups`) detected, return empty array and log a warning (Graph group lookup is deferred — access will be denied in slice 010 if groups are required but empty)
5. Return `AuthValidationResult`.

Required env vars (add to `backend/.env.example`):
- `ENTRA_TENANT_ID` — Azure AD tenant GUID
- `ENTRA_BACKEND_CLIENT_ID` — backend API app registration client ID

Wire into `backend/src/middleware/auth.ts` provider switch (placeholder from slice 008 replaced).

## Acceptance criteria

- [ ] Valid Entra access token with correct `aud`, `iss`, `tid` → `AuthValidationResult { ok: true }` with `principal.userId` = the token's `oid`.
- [ ] Expired token → `{ ok: false, status: 401, detail: 'Token expired' }`.
- [ ] Wrong `aud` → `{ ok: false, status: 401, detail: 'Invalid audience' }`.
- [ ] Wrong `tid` (different tenant) → `{ ok: false, status: 401, detail: 'Invalid tenant' }`.
- [ ] Malformed / unsigned token → 401.
- [ ] Group overage marker present → `groups: []` with logged warning; does not crash.
- [ ] JWKS is cached; a second validation in the same process does not make a second HTTP request to `login.microsoftonline.com`.
- [ ] No token contents are logged; only structured events (userId, provider, result).
- [ ] `backend/.env.example` updated with `ENTRA_TENANT_ID` and `ENTRA_BACKEND_CLIENT_ID` placeholder values.

## Blocked by

- `008-backend-auth-provider-abstraction.md` (provider switch and types must exist)

## User stories addressed

- A user with a valid Entra workforce token can reach any protected backend route.
- A token from a different tenant, an expired token, or a tampered token is rejected before any business logic executes.
