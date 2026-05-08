# Issue 027 — MSAL Silent Token Refresh on the Frontend

## Goal

Make Entra access tokens refresh silently in the browser before they expire, so users don't get bounced to `/login?reason=session-expired` mid-session.

## Context

Entra ID access tokens issued via the SPA / authorization-code flow have a default lifetime of ~1 hour. Today, the frontend reads `mike.entra.access_token` from `localStorage` and attaches it as a Bearer token to every backend call (`frontend/src/lib/auth-token.ts:9-17`, `frontend/src/app/lib/mikeApi.ts:40-43`). When the token expires, every subsequent backend call returns 401, `bounceIfUnauthorized` clears local auth state, and `window.location.href = "/login?reason=session-expired"` forces the user to sign back in.

This was hit live during the 023/024 debug session: after roughly an hour of real-time work, every API call started 401'ing. The user lost in-flight chat state, the `/llm/azure-openai/deployments` hook entered a render loop trying to retry, and the diagnostic experience was poor.

There is currently no silent refresh path. MSAL.js supports `acquireTokenSilent`, which uses the refresh token (or hidden iframe + cached session) to mint a new access token without user interaction — but the project's auth code path stores only the access token in localStorage and never calls back into MSAL once the initial sign-in completes.

## What to build

### 1. Persist the MSAL account, not just the access token

- After sign-in, store the MSAL `AccountInfo` (homeAccountId or username + tenantId) in localStorage alongside the access token. This is what `acquireTokenSilent` needs to know which account to refresh against.

### 2. Silent refresh helper

- New helper `getFreshEntraAccessToken(): Promise<string | null>` that:
  - Reads cached account from localStorage.
  - Calls `msalInstance.acquireTokenSilent({ account, scopes })`.
  - Returns the resulting token. On `InteractionRequiredAuthError`, return null and let the caller decide (most callers should fall back to `bounceIfUnauthorized` behavior).

### 3. Wire into `getBrowserAccessToken` (or its caller)

- Replace the current "read from localStorage" with "if cached token's expiry is < N minutes away, call silent refresh first; else return cached." Five minutes is a safe N; tokens are >55 minutes long.
- Persist the refreshed token back to localStorage so non-async callers (e.g., direct `fetch` outside `apiRequest`) get the fresh value too.

### 4. Centralize so all call sites benefit

- `apiRequest` in `mikeApi.ts` is the main consumer; just upgrading its `getAuthHeader()` covers most call sites.
- Any direct `fetch` that uses `getBrowserAccessToken` (search for it) should also get the refresh.

## Acceptance criteria

- [ ] A user signed in for >1 hour can continue making backend calls without being bounced to `/login`.
- [ ] On `InteractionRequiredAuthError` (e.g., refresh token also expired, ~24h), the existing `bounceIfUnauthorized` flow still kicks in cleanly — no silent failure.
- [ ] No regression for `local` or `supabase` provider modes; they don't go through MSAL.
- [ ] Token refresh adds <100ms overhead to a typical authenticated request (silent refresh is normally well under that).

## Out of scope

- Adding refresh-token rotation policy on the Entra side.
- Multi-tenant account picker / account switching.
- Backend changes — Entra JWKS validation in `validateEntraToken` already handles fresh and stale tokens correctly.

## Related

- `frontend/src/lib/auth-token.ts` — current token storage and 401 bounce.
- `frontend/src/app/lib/mikeApi.ts:40` — `getAuthHeader` is the single place to upgrade.
- Issue 013 (frontend MSAL auth provider) — landed the initial sign-in flow that this builds on.
- Issue 026 (surface silent fallbacks) — independent concern, but related: 401s should keep redirecting; non-401s should stop being silenced.
