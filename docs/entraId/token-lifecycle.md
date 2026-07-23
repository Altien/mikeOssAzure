# Entra ID token lifecycle

How authentication tokens are issued, stored, used, refreshed, and expired when
`AUTH_PROVIDER=entra`. This is the production auth mode; `local` and `supabase`
modes have their own (simpler) lifecycles noted at the end.

## Components

| Where | What it holds | Lifetime |
|---|---|---|
| Browser `localStorage["mike.entra.access_token"]` | Entra **access token** (JWT, Bearer) | ~60–90 min (Entra default) |
| Browser `localStorage["mike.entra.user"]` | Decoded `{id, email}` for UI | until logout |
| Browser cookie `mike_entra_rt` (httpOnly) | Entra **refresh token** | up to 24h–90d, Entra-controlled; rotated on each use |
| Backend | *nothing* — auth is stateless | — |

The access token is the only credential exposed to JavaScript. The refresh
token lives in an **httpOnly** cookie (`backend/src/routes/auth.ts`,
`REFRESH_COOKIE` / `refreshCookieOptions`), so XSS cannot read it.

## Sign-in flow (authorization-code, backend-mediated)

There is **no MSAL.js in the browser** — the frontend bundle is kept free of
hosted auth dependencies. The backend runs the OAuth dance:

```
Browser                         Backend (/api/auth)                 Entra
  │  click "Sign in with MS"       │                                  │
  │ ─ GET /select-provider ───────▶│                                  │
  │                                │ ─ 302 to authorize (PKCE/state) ▶│
  │ ◀──────────────── 302 ─────────┤                                  │
  │ ─────────────── authorize ────────────────────────────────────▶ │
  │ ◀──── 302 to /openid-callback?code=… ───────────────────────────┤
  │ ─ GET /openid-callback?code ──▶│                                  │
  │                                │ ─ POST /token (code) ───────────▶│
  │                                │ ◀─ access + refresh token ───────┤
  │                                │  Set-Cookie: mike_entra_rt (rt)  │
  │ ◀ 302 returnUrl#access_token ──┤  (access token in URL fragment)  │
  │  store access_token in LS      │                                  │
```

Key files: `select-provider` and `openid-callback` in
`backend/src/routes/auth.ts`; `appendTokenFragment` forwards **only** the
access token (+ `token_type`, `expires_in`) in the URL fragment — never the
refresh token. `AuthContext.tsx` reads the fragment and stores the access
token.

The OAuth scope set includes `offline_access` (`entraScopes()`), which is what
makes Entra return a refresh token at all.

## Using the access token

`getBrowserAccessToken()` (`frontend/src/lib/auth-token.ts`) returns the cached
access token; `getAuthHeader()` in `mikeApi.ts` attaches it as
`Authorization: Bearer …` to every backend call. The backend validates it per
request against Entra's JWKS (`validateEntraToken`) — stateless, no session
store.

## Silent refresh

Before this was added, an expired access token meant the next call 401'd and
the user was bounced to `/login?reason=session-expired` — including the common
"came back to an idle laptop" case. Now:

1. **Pre-emptive (the normal path).** `getBrowserAccessToken()` decodes the
   token's `exp`. If it's within `ENTRA_REFRESH_SKEW_SECONDS` (5 min) of expiry
   — or already expired — it calls `POST /api/auth/refresh` *before* returning,
   with `credentials: "include"` so the httpOnly refresh cookie is sent.
2. **Backend `/refresh`** reads the cookie, calls Entra with
   `grant_type=refresh_token`, returns a fresh access token, and **re-sets the
   cookie** with the rotated refresh token (Entra invalidates the old one on
   use — failing to persist the rotation would log the user out after one
   cycle).
3. **De-duplication.** Concurrent requests near expiry share a single in-flight
   refresh (`entraRefreshInFlight`), so a burst of calls triggers one
   round-trip, not many.

```
getBrowserAccessToken()
  └─ token within 5 min of exp?
       ├─ no  → return cached token
       └─ yes → POST /api/auth/refresh (cookie) ──▶ Entra refresh_token grant
                  ├─ 200 → store + return new access token
                  └─ 401 → return stale token → request 401s → bounce to /login
```

## Expiry and logout

- **Access token expires, refresh succeeds:** transparent; user notices
  nothing.
- **Refresh token expired/revoked (`/refresh` → 401):** the stale access token
  is returned, the request 401s, and `bounceIfUnauthorized` clears local auth
  state and redirects to `/login?reason=session-expired`. This is the *only*
  remaining forced-logout path, and it now only fires when the refresh token
  itself is gone (much longer-lived than the access token).
- **Explicit logout:** `/api/auth/logout` clears `mike_entra_rt` and redirects
  through Microsoft's logout endpoint so the IdP session is cleared too.

## Security notes

- Refresh token is **httpOnly + path-scoped to `/api/auth`** — not readable by
  JS and only sent to auth routes.
- `secure` is set in production only, so the cookie still works over plain HTTP
  on `localhost` in dev.
- `SameSite=Lax` is sufficient: frontend and backend are **same-site** in every
  deployment — same origin when the frontend is bundled into the backend, and
  both `localhost` (different ports don't change the site) when running the
  frontend dev server. CORS already allows credentials (`index.ts`,
  `cors({ credentials: true })`).
- The access token in `localStorage` is still XSS-readable; that is the
  unchanged upstream trade-off. The refresh token is *not*, which limits the
  blast radius of a token leak to ~1 hour.

## Other providers

- **local:** an HS256 JWT minted by `/api/auth/local-login`, stored in
  `localStorage["mike.local.access_token"]`, 8h lifetime, no refresh (dev only).
- **supabase:** the Supabase client owns its own session + refresh lifecycle in
  the browser; none of the above applies.
