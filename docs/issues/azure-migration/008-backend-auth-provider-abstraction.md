## Parent docs

`docs/entraId/entra-implementation-deep-dive.md` (Workstream 1, upstream-fork strategy)
`docs/entraId/entra-implementation-task-breakdown.md` (Tasks 1.1, 1.2, 1.4 partially)

## What to build

Introduce the provider abstraction layer in the backend so that auth behaviour can be toggled between Supabase (today) and Entra (next slice) via `AUTH_PROVIDER` env var. **This slice has zero behaviour change when `AUTH_PROVIDER=supabase`** — it is a pure refactor that makes the Entra provider slot safe to add.

### `backend/src/lib/auth/types.ts`

Normalized principal — no provider-specific imports:

```typescript
export interface AuthPrincipal {
  userId: string;       // Supabase: user UUID; Entra: oid claim
  email: string;
  tenantId?: string;    // Entra only
  groups: string[];     // Entra group object IDs; empty for Supabase
  roles: string[];      // mapped app roles; empty until slice 010
  provider: 'supabase' | 'entra';
}

export interface AuthValidationResult {
  ok: true;
  principal: AuthPrincipal;
} | {
  ok: false;
  status: 401 | 403;
  detail: string;
}
```

### `backend/src/lib/auth/providers/supabase.ts`

Move existing validation logic from `backend/src/middleware/auth.ts` verbatim. Export:

```typescript
export async function validateSupabaseToken(token: string): Promise<AuthValidationResult>
```

### `backend/src/middleware/auth.ts`

Replace direct Supabase validation with provider dispatch:

```typescript
const provider = process.env.AUTH_PROVIDER ?? 'supabase';
// provider === 'supabase' → validateSupabaseToken
// provider === 'entra'    → validateEntraToken (added in slice 009)
```

`res.locals.userId`, `res.locals.userEmail`, `res.locals.token` remain populated as before — downstream route code is untouched.
`res.locals.principal` additionally set to the full `AuthPrincipal` for use by later middleware.

### Fork-delta ledger

Create `docs/fork-delta.md` listing every file diverged from upstream OSS and the nature of the change. This slice adds the first entry.

## Acceptance criteria

- [ ] `AUTH_PROVIDER=supabase` (or unset): all existing protected routes behave identically to before this change. Existing integration paths pass.
- [ ] `AUTH_PROVIDER=entra`: middleware returns 500 with `"Entra provider not yet implemented"` (placeholder, safe error — prevents misconfiguration silently passing).
- [ ] `res.locals.userId` and `res.locals.userEmail` are still set from the Supabase path.
- [ ] `res.locals.principal` is set on success for both paths (Supabase: `groups: [], roles: [], tenantId: undefined`).
- [ ] No import of `@supabase/supabase-js` in `auth/types.ts`.
- [ ] `docs/fork-delta.md` created with initial entry.

## Blocked by

None — can start immediately, independent of all infrastructure slices.

## User stories addressed

- Entra provider can be added and tested without any risk to the existing Supabase auth path.
- Deployment with `AUTH_PROVIDER=supabase` is identical to today; rollback is a single env var change.
