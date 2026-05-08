## Parent docs

`docs/entraId/entra-implementation-deep-dive.md` (Workstream 4)
`docs/entraId/entra-implementation-task-breakdown.md` (Tasks 4.1, 4.2, 4.3)
`docs/AzureMove/azure-migration-proposal.md` (Track A, steps 3, 5)

## What to build

Replace `supabase.auth.*` in the frontend with MSAL.js (`@azure/msal-browser`). After this slice the frontend never calls Supabase for authentication; the browser holds an Entra access token that is sent to the backend on every API request.

### Install

```bash
# in frontend/
npm install @azure/msal-browser @azure/msal-react
```

### `frontend/src/lib/msal.ts` (new file)

MSAL configuration:

```typescript
import { PublicClientApplication, Configuration } from '@azure/msal-browser';

const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_ENTRA_TENANT_ID}`,
    redirectUri: process.env.NEXT_PUBLIC_REDIRECT_URI ?? '/',
  },
};

export const msalInstance = new PublicClientApplication(msalConfig);

export const backendScope = process.env.NEXT_PUBLIC_ENTRA_BACKEND_SCOPE!;
// e.g. 'api://<backend-client-id>/access_as_user'
```

Required env vars (add to `frontend/.env.local.example`):
- `NEXT_PUBLIC_ENTRA_CLIENT_ID` — frontend SPA app registration client ID
- `NEXT_PUBLIC_ENTRA_TENANT_ID` — Azure AD tenant GUID
- `NEXT_PUBLIC_ENTRA_BACKEND_SCOPE` — the API scope exposed by the backend app registration
- `NEXT_PUBLIC_REDIRECT_URI` — post-login redirect URI (e.g. `https://app.example.com/`)

### `frontend/src/contexts/AuthContext.tsx`

Replace Supabase session management with MSAL:

```typescript
// useEffect: call msalInstance.handleRedirectPromise() on mount
// getSession: msalInstance.acquireTokenSilent({ scopes: [backendScope] })
// if silent fails (interaction required): msalInstance.acquireTokenRedirect(...)
// signOut: msalInstance.logoutRedirect()
// user.id = account.localAccountId (Entra oid-derived stable ID)
// user.email = account.username
```

Expose `getAccessToken(): Promise<string>` — acquires token silently, used by `UserProfileContext` (slice 012) and `mikeApi.ts` to attach `Authorization: Bearer <token>` on every request.

`authLoading` remains in the interface; set to `false` once MSAL has processed the redirect response and determined account state.

Add `AUTH_PROVIDER` env var gating: when `NEXT_PUBLIC_AUTH_PROVIDER=supabase` (or unset), keep the existing Supabase path. When `NEXT_PUBLIC_AUTH_PROVIDER=entra`, use MSAL. This allows a staged rollout — run Supabase in prod while testing Entra in dev.

### `frontend/src/app/login/page.tsx`

Replace email/password Supabase form:
- When `AUTH_PROVIDER=entra`: single button — "Sign in with Microsoft". Calls `msalInstance.loginRedirect({ scopes: [backendScope] })`. Standard Microsoft organizational sign-in UX.
- When `AUTH_PROVIDER=supabase`: existing form unchanged.

### Files removed when `AUTH_PROVIDER=entra` is the only active path

- `frontend/src/lib/supabase.ts` — delete or gate behind `AUTH_PROVIDER=supabase` check.
- `frontend/src/lib/supabase-server.ts` — delete (server-side Supabase auth is gone).
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` — removed from `.env.local.example` (or marked as Supabase-mode-only).

### `frontend/src/components/providers.tsx`

Wrap the app in `MsalProvider` (from `@azure/msal-react`) when `AUTH_PROVIDER=entra`. The `MsalProvider` wraps everything inside `AuthProvider`.

### `frontend/src/app/layout.tsx`

No changes required beyond what `providers.tsx` already does.

## Acceptance criteria

- [ ] `NEXT_PUBLIC_AUTH_PROVIDER=entra`: clicking "Sign in with Microsoft" redirects to the Microsoft login page; after successful login, the user is redirected back and `isAuthenticated` is `true`.
- [ ] Access token is attached to all `mikeApi` requests as `Authorization: Bearer <token>`; backend validates it via Entra JWKS (slice 009) and returns data.
- [ ] Token refresh is silent — the user is not prompted to log in again while the refresh token is valid.
- [ ] `signOut()` calls `msalInstance.logoutRedirect()`; `isAuthenticated` becomes `false`; user is redirected to the Microsoft logout page.
- [ ] `NEXT_PUBLIC_AUTH_PROVIDER=supabase` (or unset): Supabase login form works exactly as before — no regression.
- [ ] `frontend/src/lib/supabase.ts` and `supabase-server.ts` are deleted (or explicitly gated); `NEXT_PUBLIC_SUPABASE_URL` is not required in Entra mode.
- [ ] `npm run build` in `frontend/` completes without TypeScript errors.
- [ ] End-to-end: login → navigate to a protected page → data loads → logout → protected page redirects to login.

## Blocked by

- `009-backend-entra-jwt-validation.md` (backend must validate Entra tokens before the frontend can send them)
- `012-frontend-userprofile-refactor.md` (profile ops must be on the backend before Supabase client is removed)

## User stories addressed

- Workforce users see the standard Microsoft organizational sign-in flow they expect in enterprise apps.
- No Supabase environment variables are required in Entra mode.
- Developers can still run the app in Supabase mode locally without Entra app registrations.
