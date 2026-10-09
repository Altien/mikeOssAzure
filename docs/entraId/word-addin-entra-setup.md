# Word Add-in — Entra Sign-in Setup

*As of 2026-09-29*

## In short

The Word add-in now signs in with Microsoft Entra, not Supabase, but it
**cannot sign anyone in until four redirect URIs are added to the frontend's
Entra app registration.**

- **What changed:** upstream's Word add-in (PR #221) was brought into the dev
  fork, and its sign-in was rewritten to use MSAL.js against the same app
  registration the web frontend already uses.
- **What you must do:** add the redirect URIs in the checklist below. No new
  API permissions or consent are needed.
- **Still open:** production hosting is blocked by CORS; see
  [Open decisions](#open-decisions).
- **Status:** it builds and type-checks. Nobody has run it inside a real Word yet.

## Checklist: set up the Entra app registration

Do this once per environment, in the Azure portal, on the **frontend's** app
registration. Its client id is the Key Vault secret `entra-client-id`.

1. Open **Microsoft Entra ID → App registrations**, then the **frontend** app
   (not the backend API app).
2. Go to **Authentication → Add a platform → Single-page application**, or edit
   the existing SPA platform.
3. Add these redirect URIs. Replace `<add-in host>` with the host of
   `WORD_ADDIN_PUBLIC_URL`.

   | Redirect URI | Used for | Environment |
   | --- | --- | --- |
   | `brk-multihub://localhost:3000` | Nested App Authentication (inside Word) | Local dev |
   | `https://localhost:3000/auth-dialog.html` | Dialog fallback (older Word) | Local dev |
   | `brk-multihub://<add-in host>` | Nested App Authentication (inside Word) | Production |
   | `https://<add-in host>/auth-dialog.html` | Dialog fallback (older Word) | Production |

4. Save. Leave **API permissions** alone: the frontend app already has
   `api://<backend client id>/access_as_user` with admin consent.
5. Production only: resolve CORS first (see below), or the add-in's API calls
   will be blocked.

- [ ] Local dev redirect URIs added
- [ ] Production redirect URIs added
- [ ] Production CORS resolved

## How sign-in works now

```
Word task pane
  │  GET <backend origin>/config  → tenantId, clientId, apiScope
  │
  ├─ Host supports NestedAppAuth 1.1? ── yes ─→ MSAL NAA (silent, inside Word)
  │                                     no  ─→ Office dialog → auth-dialog.html
  │                                             → MSAL redirect → token posted back
  ▼
Bearer token (aud = backend API)  →  <backend origin>/api/*  →  existing Entra validator
```

- **Library:** `@azure/msal-browser` ^4.30. It is pinned to v4 because v5
  changed how redirects are handled.
- **Token:** issued to the web frontend's client id for scope
  `api://<backend client id>/access_as_user`. The backend's Entra validator is
  unchanged and accepts it exactly as it accepts the web app's token.
- **Config is fetched at runtime.** Only the backend origin is baked in
  (`REACT_APP_API_BASE_URL`). Tenant, client id and scope come from `GET /config`.
- **`/config` backend change:** it now also returns `entra.apiScope`, and reads
  the Entra ids env-first, then Key Vault. It used to read env only, which
  returned empty values on Azure deploys, where the ids live only in Key Vault.
- **Session:** silent renewal near expiry; on a 401 it forces one silent
  renewal, then shows the login page. Sign-out suppresses silent SSO until the
  next interactive sign-in, because under NAA the Office account stays signed in.
- **Other auth modes:** `local` mode works (`POST /api/auth/local-login`).
  Supabase mode shows a NOT SUPPORTED message.

## Open decisions

| Decision | Current state | Alternative | Cost of the alternative |
| --- | --- | --- | --- |
| Which app registration the add-in uses | Reuses the frontend's: no new consent, same token as the web app | A separate add-in registration | `/config` serves a second client id; its own `access_as_user` permission and admin consent |
| How production reaches the API | **Not solved.** Backend CORS only allows `FRONTEND_URL`, so an add-in on its own origin is blocked | Serve the add-in from the backend's origin, or add its origin to the CORS allow-list | A hosting change, or a small backend config change |
| Redirect URIs in the install scripts | Manual. The install scripts don't add them | Add them to `create-entra-apps.ps1` / `register-redirect-uris.ps1` | Small script change; new environments get them automatically |

Two smaller gaps to check on first run: the default model is still
`claude-sonnet-4-6` (`REACT_APP_DEFAULT_MODEL`), and the API-key banner links to
`<web>/account/api-keys`.

## How to check it works

Run these after the local redirect URIs are in.

1. Start the backend in Entra mode. In `word-addin/`, run `pnpm install` then
   `pnpm start`.
2. Open `<backend origin>/config`. Confirm `entra.tenantId`, `entra.clientId`
   and `entra.apiScope` are filled in, not empty.
3. Sideload the add-in into Word (desktop or Word on the web) and open the
   task pane.
4. Sign in. Current Word builds should sign in silently (NAA); older builds
   open a small sign-in dialog instead.
5. Send a chat message about the open document. An answer proves the backend
   accepted the token.
6. Sign out, reopen the pane, and confirm it asks you to sign in again.

A redirect-URI error at step 4 (AADSTS50011) means a URI from the checklist is
missing or mistyped.

## Reference

| Item | Where |
| --- | --- |
| MSAL sign-in code | `word-addin/src/taskpane/auth/entra.ts` |
| Session and token renewal | `word-addin/src/taskpane/auth/session.ts` |
| Runtime config client | `word-addin/src/taskpane/auth/runtimeConfig.ts` |
| Dialog fallback page | `word-addin/src/auth-dialog/auth-dialog.html` + `auth-dialog.ts` |
| Runtime config endpoint | `backend/src/routes/config.ts` |
