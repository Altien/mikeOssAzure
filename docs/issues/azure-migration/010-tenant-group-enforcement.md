## Parent docs

`docs/entraId/entra-implementation-deep-dive.md` (Workstream 2, Workstream 3)
`docs/entraId/entra-implementation-task-breakdown.md` (Tasks 2.1, 2.2, 2.3, 3.1, 3.2)

## What to build

Add group-to-role mapping, tenant lifecycle enforcement, and the persistence layer for tenant policy. After this slice a user must be (a) in an active tenant and (b) a member of at least one whitelisted Entra group to reach any protected route.

### `backend/src/lib/auth/roles.ts`

Config-driven mapping from Entra group object IDs to app roles:

```typescript
export type AppRole = 'TenantAdmin' | 'Member';

export function resolveRoles(groups: string[]): AppRole[]
// reads ENTRA_ADMIN_GROUP_IDS (comma-separated OIDs) from env
// group in admin list → ['TenantAdmin', 'Member']
// group in any other whitelisted list → ['Member']  (ENTRA_MEMBER_GROUP_IDS, optional)
// no match → []
```

Add env vars to `backend/.env.example`: `ENTRA_ADMIN_GROUP_IDS`, `ENTRA_MEMBER_GROUP_IDS` (optional).

### `backend/src/middleware/tenantAccess.ts`

Runs after `requireAuth`; only active when `AUTH_PROVIDER=entra`:

1. Look up `principal.tenantId` in the `tenants` table.
2. If not found: deny with `403 TENANT_UNKNOWN` (auto-onboarding mode creates the row; manual mode is config-driven via `TENANT_ONBOARDING_MODE=auto|manual`).
3. If found but `status != 'active'`: deny with `403 TENANT_SUSPENDED` or `403 TENANT_PENDING`.
4. Call `resolveRoles(principal.groups)`.
5. If `roles` is empty: deny with `403 GROUP_NOT_WHITELISTED`.
6. Set `res.locals.principal.roles = roles`.
7. `next()`.

All denials log: `{ tenantId, userId, reason, timestamp }` — no token contents.

### `backend/src/middleware/requireRole.ts`

```typescript
export function requireRole(role: AppRole): RequestHandler
// returns 403 if res.locals.principal.roles does not include role
```

Used on admin-only routes (applied incrementally; no route changes required in this slice — just the helper).

### Migration: `backend/migrations/0001_tenant_policy.sql`

```sql
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null unique,   -- Entra tid claim
  status text not null default 'active'
    check (status = any (array['active','pending','suspended'])),
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_group_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  group_object_id text not null,
  role text not null,
  created_at timestamptz not null default now(),
  unique(tenant_id, group_object_id)
);
```

`TENANT_ONBOARDING_MODE=auto`: on first request from an unknown tenant, insert `tenants` row with `status='active'`. Suitable for dev/early rollout. `manual`: operator must insert the row before users can access.

### Route wiring

Apply `tenantAccess` middleware globally in `backend/src/index.ts` after `requireAuth`, but only when `AUTH_PROVIDER=entra`. Supabase path is unaffected.

## Acceptance criteria

- [ ] `AUTH_PROVIDER=supabase`: no change to existing behaviour — `tenantAccess` middleware is not inserted.
- [ ] `AUTH_PROVIDER=entra`, user in whitelisted admin group, active tenant → request proceeds; `res.locals.principal.roles` includes `TenantAdmin`.
- [ ] `AUTH_PROVIDER=entra`, user in no whitelisted group → 403 with reason `GROUP_NOT_WHITELISTED`.
- [ ] `AUTH_PROVIDER=entra`, tenant `status='suspended'` → 403 with reason `TENANT_SUSPENDED`.
- [ ] `TENANT_ONBOARDING_MODE=auto`: first request from unknown tenant creates `tenants` row and proceeds.
- [ ] `TENANT_ONBOARDING_MODE=manual`: first request from unknown tenant → 403 `TENANT_UNKNOWN`.
- [ ] `requireRole('TenantAdmin')` on a non-admin returns 403; on an admin proceeds.
- [ ] Migration `0001_tenant_policy.sql` applies cleanly after `0000_initial.sql`; idempotent on second run.
- [ ] Deny events are logged with `tenantId`, `userId`, `reason`, `timestamp` — no JWT contents in logs.

## Blocked by

- `008-backend-auth-provider-abstraction.md`
- `009-backend-entra-jwt-validation.md`
- `004-schema-migration-tooling.md` (migration runner must exist to apply `0001_tenant_policy.sql`)

## User stories addressed

- Only users from the customer's own Entra tenant who belong to a configured group can access the application.
- An admin-capable user can be identified by group membership, not by a hardcoded user ID.
- A suspended tenant is blocked at the middleware layer before any business logic runs.
