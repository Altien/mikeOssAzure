# Entra ID PR-Ready Task Breakdown

## Epic Goal

Implement Entra ID tenant-installed authentication and group whitelist authorization with minimal divergence from upstream OSS.

## Workstream 1: Backend Provider Abstraction

### Task 1.1 - Add auth core types
- Create `backend/src/lib/auth/types.ts`.
- Define normalized principal and validation result contracts.

**Acceptance Criteria**
- No provider-specific imports.
- Shared by middleware and providers.

### Task 1.2 - Move Supabase validation into provider module
- Create `backend/src/lib/auth/providers/supabase.ts`.
- Keep existing validation behavior intact.

**Acceptance Criteria**
- `AUTH_PROVIDER=supabase` behaves exactly as today.

### Task 1.3 - Implement Entra provider
- Create `backend/src/lib/auth/providers/entra.ts`.
- Implement OIDC/JWKS verification and required claim checks.
- Read name/email from token claims by default; support Graph fallback only when claims are insufficient.

**Acceptance Criteria**
- Invalid tokens/claims denied.
- Valid tokens produce normalized principal.
- Profile extraction works from claims-first with fallback behavior defined.

### Task 1.4 - Wire provider switch in middleware
- Update `backend/src/middleware/auth.ts`.

**Acceptance Criteria**
- Provider switch via env.
- Backward compatibility fields in `res.locals` retained during migration.

## Workstream 2: Tenant and Group Enforcement

### Task 2.1 - Add role mapping utility
- Create `backend/src/lib/auth/roles.ts`.
- Map Entra group object IDs to app roles from app configuration.

**Acceptance Criteria**
- Admin group membership yields `TenantAdmin`.
- Mapping is settings-driven and tenant-configurable.

### Task 2.2 - Add tenant access middleware
- Create `backend/src/middleware/tenantAccess.ts`.

**Acceptance Criteria**
- Unknown/inactive/suspended tenant denied.
- Disallowed group denied.

### Task 2.3 - Add admin guard helper
- Create `backend/src/middleware/requireRole.ts`.

**Acceptance Criteria**
- Admin-only routes protected with consistent 403 behavior.

## Workstream 3: Persistence

### Task 3.1 - Tenant policy migration
- Add new incremental migration under `backend/migrations/`.

**Acceptance Criteria**
- Adds tenant and group policy tables.
- Migration applies cleanly on existing DBs.

### Task 3.2 - Tenant bootstrap behavior
- Add helper for first-login tenant creation/activation policy.

**Acceptance Criteria**
- Auto or manual onboarding mode works via config.

## Workstream 4: Frontend Auth Provider Switch

### Task 4.1 - Provider-aware AuthContext
- Update `frontend/src/contexts/AuthContext.tsx`.

**Acceptance Criteria**
- Supabase mode remains stable.
- Entra mode exposes tenant + role info.

### Task 4.2 - Login page provider UX
- Update `frontend/src/app/login/page.tsx`.

**Acceptance Criteria**
- Supabase mode keeps email/password.
- Entra mode uses the standard Microsoft organizational sign-in UX.

### Task 4.3 - Request helper abstraction
- Update `frontend/src/lib/auth.ts` or split provider files.

**Acceptance Criteria**
- Existing caller API remains stable.

## Workstream 5: Route Hardening

### Task 5.1 - Incremental route enforcement
- Apply tenant and role checks to sensitive endpoints.

**Acceptance Criteria**
- No cross-tenant access.
- Admin-only endpoints require admin role.

## Workstream 6: Testing and Verification

### Task 6.1 - Unit tests
- Claim validation, role mapping, deny-reason mapping.

### Task 6.2 - Integration tests
- Allowed tenant/group success.
- Disallowed group/tenant fail.
- Supabase mode regression pass.

### Task 6.3 - Security checks
- Expired token, bad issuer/audience, key rollover handling.

## Release Strategy

1. Deploy with `AUTH_PROVIDER=supabase` (no behavior change).
2. Enable Entra in staging with test tenant.
3. Run deny-path and admin-path checks.
4. Controlled production rollout by tenant.

## Definition of Done

- Provider switch operational.
- Entra token + tenant validation in place.
- Group whitelist role enforcement in place.
- Supabase fallback remains functional.
- Fork delta remains modular and upstream-friendly.


## Clarified Product Decisions (Locked)

- Access is granted when a user is in the customer tenant **and** is a member of at least one whitelisted Entra group.
- Name/email should come from Entra claims first; Graph is fallback only when required.
- Admin capability is granted by organization-defined Entra group membership configured in app settings.
