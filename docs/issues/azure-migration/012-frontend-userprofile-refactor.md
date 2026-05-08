## Parent docs

`docs/Postgres/002-postgrest-and-access-pattern.md` (9-callsite browser refactor)
`docs/entraId/entra-implementation-task-breakdown.md` (Task 4.3)

## What to build

Remove all direct `supabase.from('user_profiles')` calls from the browser. After this slice the browser never talks to PostgREST — all profile operations go through the Express backend endpoints added in slice 011.

### Files to change

**`frontend/src/contexts/UserProfileContext.tsx`**

Replace every `supabase.from('user_profiles').*` call with a call to the Express API via the existing `mikeApi` fetch helper (or equivalent authenticated fetch):

| Current Supabase call | Replace with |
|---|---|
| `.from('user_profiles').select('*').eq('user_id', userId).single()` | `GET /user/profile` |
| `.from('user_profiles').update({ display_name }).eq('user_id', userId)` | `PATCH /user/profile` `{ display_name }` |
| `.from('user_profiles').update({ organisation }).eq('user_id', userId)` | `PATCH /user/profile` `{ organisation }` |
| `.from('user_profiles').update({ tabular_model }).eq('user_id', userId)` | `PATCH /user/profile` `{ tabular_model }` |
| `.from('user_profiles').update({ claude_api_key }).eq('user_id', userId)` | `PATCH /user/profile` `{ claude_api_key }` |
| `.from('user_profiles').update({ gemini_api_key }).eq('user_id', userId)` | `PATCH /user/profile` `{ gemini_api_key }` |
| `.from('user_profiles').update({ message_credits_used }).eq('user_id', userId)` | `POST /user/profile/credits/increment` |
| `.from('user_profiles').update({ message_credits_used: 0, credits_reset_date }).eq('user_id', userId)` | Removed — backend handles reset inside `GET /user/profile` (slice 011) |

The `supabase` import at the top of this file is removed entirely once all callsites are replaced. The component must still get an auth token to pass in the `Authorization` header — this comes from `AuthContext` (currently Supabase session; after slice 013 it comes from MSAL). Expose `getAccessToken(): Promise<string>` from `AuthContext` to keep the token-acquisition detail isolated.

**`frontend/src/app/signup/page.tsx`**

This page uses Supabase sign-up, which is meaningless with Entra workforce auth. Replace the entire page body with a redirect to the login page or a static message: _"Account creation is managed by your organisation. Please sign in with your Microsoft account."_ The page route can remain at `/signup` to avoid broken links.

### What does NOT change in this slice

- `frontend/src/lib/supabase.ts` — still referenced by `AuthContext.tsx` (Supabase auth session). Removed in slice 013.
- `frontend/src/lib/supabase-server.ts` — server-side; removed in slice 013.
- Any component that calls `mikeApi.*` — unchanged (those already go through the backend).

## Acceptance criteria

- [ ] Browser Network tab shows zero requests to the Supabase PostgREST URL (`*.supabase.co`) for profile operations after login.
- [ ] `UserProfileContext` loads profile data correctly from `GET /user/profile`.
- [ ] Display name, organisation, model preference, and API key updates work end-to-end.
- [ ] Credit increment (`POST /user/profile/credits/increment`) works.
- [ ] `frontend/src/contexts/UserProfileContext.tsx` contains no import of `@supabase/supabase-js` or `../lib/supabase`.
- [ ] `/signup` route renders the "contact your admin" message instead of the Supabase sign-up form.
- [ ] TypeScript builds without errors (`npm run build` in `frontend/`).

## Blocked by

- `011-user-bootstrap-and-profile-endpoints.md` (backend endpoints must exist before the frontend can call them)

## User stories addressed

- The browser has no path to PostgREST or the database — all data access is mediated by the Express backend.
- Users on an Entra workforce tenant are not presented with a Supabase email/password sign-up form.
