# Entra ID Implementation Deep Dive

## Context and Intent

This implementation is for a customer-tenant-installed model where users authenticate with the organization tenant in which the app is installed.

Core outcomes:
- Org-only authentication (no personal Microsoft accounts).
- Tenant-bound access.
- Group whitelist enforcement.
- At minimum, an Admin group role.
- Minimal fork delta to keep upstream OSS sync clean.

## Recommended Architecture

Use a controlled multi-tenant install model with strong tenant and group controls.

### Why
- Matches tenant-installed customer expectation while avoiding per-customer code forks.
- Keeps operations manageable.
- Supports clean extension points and upstream mergeability.

## Current Code Baseline (Observed)

- Backend auth middleware validates Supabase bearer tokens and stores user identity in `res.locals`.
- Frontend server-side auth helper validates Supabase tokens.
- Frontend auth context is Supabase-session based (`getSession`, `onAuthStateChange`, `signOut`).
- Login page uses Supabase email/password.
- Schema is predominantly user/email scoped, not explicit tenant scoped.

## Target Technical Design

### 1) Provider-Abstraction Layer

Add provider switch (`AUTH_PROVIDER=supabase|entra`) with normalized principal:
- `userId`
- `email`
- `tenantId`
- `groups[]`
- `roles[]`
- `provider`

Keep Supabase path intact for fallback and safe rollout.

### 2) Entra Token Validation Requirements

- Validate signature from tenant OIDC JWKS.
- Validate claims: `iss`, `aud`, `tid`, `exp`, `nbf`.
- Reject tokens missing required tenant context.
- Support group overage behavior (token groups too large).

### 3) Tenant Guardrails

Enforce tenant lifecycle:
- `active`
- `pending`
- `suspended`

Block non-active tenants before business logic.

### 4) Group-to-Role Mapping

Config-driven mapping from Entra group object IDs to app roles, starting with:
- `TenantAdmin`

Suggested env variables:
- `ENTRA_ADMIN_GROUP_IDS`
- `ENTRA_EDITOR_GROUP_IDS` (optional later)
- `ENTRA_VIEWER_GROUP_IDS` (optional later)

### 5) Authorization Policy

- Hard deny if tenant is not allowed/active.
- Hard deny if user lacks whitelisted group membership.
- Route-level admin checks for sensitive operations.
- Standardized deny reason codes for auditability.

### 6) Data Model Evolution

Add incremental migration(s) for tenant policy storage:
- `tenants` table
- `tenant_group_policies` table
- optional auth audit table

Do not rewrite core schema immediately; migrate incrementally for minimal risk.

## Upstream-Fork Strategy (Critical)

To preserve ability to accept upstream commits:

1. Prefer additive modules over broad edits.
2. Keep provider-specific code isolated (`lib/auth/providers/*`).
3. Keep existing Supabase behavior untouched when provider is `supabase`.
4. Use feature flags/env toggles rather than invasive branching.
5. Maintain a fork-delta ledger document.

## Security Baseline

- Principle of least privilege for Entra app permissions.
- Strict JWT validation and key rotation handling.
- Group overage fallback behavior defined and tested.
- No token dumps in logs; only structured reasoned events.
- Add deny auditing: tenant, user, reason, timestamp.

## Decisions Confirmed

1. **Access rule**: if user belongs to the customer tenant and is in an app-whitelisted Entra group, they are authorized.
2. **Identity fields**: read name/email from Entra token claims; use Microsoft Graph only when needed (e.g., group overage / missing claims).
3. **Group-to-function mapping**: configuration-driven role mapping is required; source can be Entra claims or Graph, favoring the simplest reliable path.
4. **Frontend auth UX**: use standard Microsoft organizational login flow users expect in enterprise apps.
5. **Admin definition**: admins are members of organization-defined Entra group(s) configured in app settings.

### Practical default
- Try token claims first for groups and profile fields.
- Fall back to Graph only when claim payload is insufficient.
- Deny access when neither source can prove required group membership.

## Delivery Sequence

1. Backend provider seam.
2. Entra provider + claim validation.
3. Group mapping + tenant middleware.
4. Policy persistence migration.
5. Frontend provider switch + login UX.
6. Route-by-route authz hardening + tests.
