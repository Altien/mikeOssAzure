## Parent docs

`docs/Postgres/004-entraid-handoff.md` (items 1, 2)
`docs/entraId/entra-implementation-task-breakdown.md` (Task 3.2)
`docs/Postgres/002-postgrest-and-access-pattern.md`

## What to build

Replace the Supabase `on_auth_user_created` trigger with application-level profile creation, and extend the Express `/user/profile` surface to cover all operations currently performed directly against PostgREST by the browser.

### User bootstrap

Add `upsertUserProfile(principal: AuthPrincipal): Promise<void>` to `backend/src/lib/userSettings.ts` (or a new `backend/src/lib/auth/bootstrap.ts`):

```typescript
// INSERT INTO public.user_profiles (user_id, display_name)
// VALUES ($1, $2)
// ON CONFLICT (user_id) DO NOTHING
```

Call this from `backend/src/middleware/auth.ts` immediately after successful validation (both Supabase and Entra paths). Idempotent — safe to call on every authenticated request; the `ON CONFLICT DO NOTHING` makes subsequent calls a fast no-op.

`user_id` is set to `principal.userId` (Supabase UUID or Entra `oid`). The column is already `uuid not null unique` after slice 004 removed the FK.

### Backend profile endpoints

Audit all `supabase.from('user_profiles')` operations in `frontend/src/contexts/UserProfileContext.tsx` and `frontend/src/app/signup/page.tsx`. For each operation not already covered by the Express backend, add the corresponding endpoint to `backend/src/routes/user.ts`:

| Frontend operation | Express endpoint |
|---|---|
| `SELECT * WHERE user_id = $uid` (load profile) | `GET /user/profile` (already exists — verify response shape matches) |
| `UPDATE SET display_name` | `PATCH /user/profile` with `{ display_name }` |
| `UPDATE SET organisation` | `PATCH /user/profile` with `{ organisation }` |
| `UPDATE SET tabular_model` | `PATCH /user/profile` with `{ tabular_model }` |
| `UPDATE SET claude_api_key / gemini_api_key` | `PATCH /user/profile` with `{ claude_api_key }` / `{ gemini_api_key }` |
| `UPDATE SET message_credits_used` | `POST /user/profile/credits/increment` |
| `UPDATE SET message_credits_used, credits_reset_date` (reset) | folded into `GET /user/profile` response — backend computes and resets in the same call |

All endpoints require `requireAuth` middleware. User may only read/write their own profile (`WHERE user_id = res.locals.userId`).

The `signup/page.tsx` Supabase call (the 1 callsite noted in `002-postgrest-and-access-pattern.md`) is removed entirely in slice 012 when the signup page itself is removed.

## Acceptance criteria

- [ ] First authenticated request from a user with no existing `user_profiles` row → row created with correct `user_id` and default values. Second request → no duplicate row, no error.
- [ ] `GET /user/profile` returns all fields needed by `UserProfileContext`: `display_name`, `organisation`, `message_credits_used`, `credits_reset_date`, `tier`, `tabular_model`, `claude_api_key`, `gemini_api_key`.
- [ ] `PATCH /user/profile` updates the requested field; returns updated profile or 200.
- [ ] `POST /user/profile/credits/increment` increments `message_credits_used` by 1; returns updated count.
- [ ] `GET /user/profile` resets `message_credits_used` to 0 and updates `credits_reset_date` when the current date is past the reset date (eliminating the need for the browser to write the reset).
- [ ] A user cannot read or write another user's profile (returns 403).
- [ ] Supabase path (`AUTH_PROVIDER=supabase`) continues to work — `upsertUserProfile` runs on both paths.

## Blocked by

- `009-backend-entra-jwt-validation.md` (principal must carry `userId` for profile upsert)
- `010-tenant-group-enforcement.md` (auth middleware must be complete before routes are wired)
- `004-schema-migration-tooling.md` (schema must exist)

## User stories addressed

- A user logging in for the first time via Entra gets a profile row automatically — no trigger, no Supabase dependency.
- All profile read/write operations are available through the Express API, enabling the frontend to stop talking to PostgREST directly.
