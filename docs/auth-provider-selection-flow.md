# Auth Provider Selection Flow

Date: 2026-05-05

## Why This Exists

MatterAI has a working provider-selection pattern for local and hosted validation:

1. the browser starts at a backend auth selection endpoint;
2. the backend chooses a configured provider;
3. the backend redirects to the provider authorization URL;
4. the provider redirects back to a backend callback;
5. the backend completes the token exchange and returns the browser to the app.

This repo now mirrors that shape for Microsoft Entra while preserving the current frontend contract: browser code stores an access token and sends it to the Node API as a bearer token.

## Current Implementation

Backend routes live in `backend/src/routes/auth.ts`:

- `GET /auth/providers`
  - reports the currently enabled backend auth provider.
- `GET /auth/select-provider?returnUrl=...&selectAccount=true`
  - MatterAI-style entry point used by the frontend.
  - currently redirects to Microsoft when `AUTH_PROVIDER=entra`.
- `GET /auth/login-provider/microsoft`
  - builds the Microsoft authorize URL using backend environment configuration.
  - signs the frontend return URL into the OAuth `state` parameter.
- `GET /auth/openid-callback/microsoft`
  - exchanges the authorization code for tokens.
  - redirects back to the frontend return URL with the access token in the URL fragment.
- `POST /auth/local-login`
  - remains the local-only development login path when `AUTH_PROVIDER=local`.

Frontend login now redirects to `NEXT_PUBLIC_API_BASE_URL/auth/select-provider` for Entra. It does not construct the Microsoft authorize URL itself.

## Deliberate Differences From MatterAI

MatterAI creates a backend session cookie after OpenID login. This repo still uses bearer tokens in the browser because that is the smallest change compatible with the existing frontend/backend API calls.

MatterAI supports a configurable provider landing page with multiple providers. This repo currently exposes the same route shape, but only Microsoft is wired through because the backend token validator only supports Supabase, local JWTs, and Entra.

Google should not be added as a visible login provider until the backend has a matching validator or session bridge. Showing a provider that cannot authorize API calls would create a broken login.

## Required Backend Environment For Entra

The full portal setup is documented in `docs/runbook-entra-local-auth.md`.

Set these in `backend/.env` when `AUTH_PROVIDER=entra`:

```env
AUTH_PROVIDER=entra
FRONTEND_URL=http://localhost:3000
BACKEND_PUBLIC_URL=http://localhost:3001

ENTRA_TENANT_ID=your-tenant-id
ENTRA_BACKEND_CLIENT_ID=your-backend-app-registration-client-id
ENTRA_CLIENT_ID=your-web-or-spa-app-registration-client-id
ENTRA_CLIENT_SECRET=your-web-app-client-secret
ENTRA_BACKEND_SCOPE=api://your-backend-app-registration-client-id/access_as_user
ENTRA_REDIRECT_URI=http://localhost:3001/auth/openid-callback/microsoft
AUTH_STATE_SECRET=change-me-for-signed-login-state
```

`ENTRA_BACKEND_SCOPE` must request an access token for the Node API. The existing backend validator checks the token audience against `ENTRA_BACKEND_CLIENT_ID`.

## Required Frontend Environment For Entra

Set:

```env
NEXT_PUBLIC_AUTH_PROVIDER=entra
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_ENTRA_TENANT_ID=your-tenant-id
NEXT_PUBLIC_ENTRA_CLIENT_ID=your-client-id
NEXT_PUBLIC_REDIRECT_URI=http://localhost:3000/login
```

After issue 030 the backend serves `GET /config` with the Entra
client settings the browser bundle needs. Sign-out goes through
`GET /auth/logout` which constructs the Microsoft logout URL
server-side. The bundle has no `NEXT_PUBLIC_ENTRA_*` reads.

After issue 031 the frontend supabase client is constructed
lazily and only when `authProvider === "supabase"`, so non-supabase
deployments need no `NEXT_PUBLIC_SUPABASE_*` env vars at all.

## Local Development Modes

Use `AUTH_PROVIDER=local` for the fastest local development loop. That path does not need Microsoft configuration and posts only to `/auth/local-login`.

Use `AUTH_PROVIDER=entra` when validating the real Microsoft tenant flow locally. In that mode, start the backend on `localhost:3001`, start the frontend on `localhost:3000`, then click "Sign in with Microsoft" on `/login`.

As of 2026-05-05, this flow was validated locally through successful Microsoft authentication and return to the app.

## Mini-Sprint Findings

- The backend intentionally has no `GET /` route; use `/health` for browser health checks.
- The Entra login path should be backend-owned, matching the MatterAI provider selection pattern, rather than constructing Microsoft authorize URLs in the React login page.
- The current backend validator expects an API access token whose audience is the backend app registration client ID. Requesting only `openid profile email` is not enough.
- The Web/Login app registration must use a **Web** redirect URI at `http://localhost:3001/auth/openid-callback/microsoft` because the local backend exchanges the authorization code with a client secret.
- Google should stay hidden until a backend validator or backend session bridge exists. MatterAI can show multiple providers because it creates server-side sessions; this repo still uses bearer tokens to call the Node API.
- Supabase is still present as a compatibility boundary for PostgREST and for some frontend imports. We should isolate those imports before deleting the package or env surface.

## Upstream Compatibility Note

This is intentionally a provider boundary, not a broad auth rewrite. The frontend keeps using `useAuth()`, backend protected routes keep using `requireAuth`, and Supabase mode remains present. That makes it easier to extract upstream-friendly PRs around auth interfaces without mixing them with Azure-specific policy.
