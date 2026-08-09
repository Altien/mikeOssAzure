# Mike Word Add-in

An Office.js task pane add-in that brings the Mike legal AI platform directly into Microsoft Word. From the task pane you can chat with an AI about the open document, attach additional documents and workflows, choose a model, receive suggestions that are applied immediately as tracked-change redlines, accept or reject them individually or as a group, launch configurable quick actions, and execute saved Mike workflows against the document — all without leaving Word.

The add-in talks to the **same backend as the web app**: sign-in is **Microsoft Entra** via MSAL.js (Nested App Authentication, with an Office-dialog fallback — see [Signing in](#signing-in)), configured at runtime from the backend's `GET /config`; chat, actions, workflows, projects, and uploads call the Mike API under `/api` (`http://localhost:3001` in local development).

> **Dev fork:** upstream's add-in signs in against Supabase. This fork replaced that with Entra/MSAL (the backend accepts the add-in's token exactly as it accepts the web frontend's), uses pnpm, and does not ship upstream's Supabase-bootstrapped Playwright suites (`e2e/`, `e2e-live/`).

---

## Prerequisites

- Node.js 22+
- Microsoft Word desktop (macOS or Windows) **or** Word on the web — sideloading steps differ; see below (desktop is the smoother path for local development)
- pnpm (the repo enforces it via `only-allow`)
- The Mike API running locally (`pnpm dev` from `backend/`) with `AUTH_PROVIDER=entra` and the app registration set up per [Signing in](#signing-in) — or `AUTH_PROVIDER=local` (+ `JWT_SECRET`) for an Entra-free development login
- A Mike user — with Entra, any user of the tenant the web app signs in with (the same account as the web app).
- For real model responses, a model credential the backend can use (organisation keys in Key Vault / env, or Azure OpenAI).

---

## Quick start (one command)

If the API is already running, this script does everything below for you — reads the backend origin (`NEXT_PUBLIC_API_BASE_URL` in `frontend/.env.local`, default `http://localhost:3001`), writes `.env.development`, installs dependencies, installs the trusted dev certificate, and launches the add-in into Word:

```bash
bash word-addin/scripts/dev.sh
```

It is idempotent (safe to re-run) and only prompts you when it genuinely needs input — namely the **keychain/admin password** when installing the dev HTTPS certificate the first time. After the cert installs, **fully quit Word (Cmd-Q)** and re-run the script so Word reloads the trust.

The script verifies the backend before launching:

- **Mike backend** — `GET <api>/api/health`
- **Auth mode** — `GET <api>/config` (`entra` or `local` are supported)

If the backend is down it prints how to start it and **refuses to launch** (the task pane would just fail to sign in). Start the backend first:

```bash
# from backend/
pnpm dev                     # the Mike API on :3001
```

Flags:
- `--setup-only` — do everything except the final `pnpm start` (prep deps/env/cert; report backend status without launching).
- `FORCE=1 bash word-addin/scripts/dev.sh` — launch even if the backend check fails (sign-in won't work until Mike is up).

The sections below explain each step the script automates, and the manual / web sideloading paths.

---

## Setup (manual)

1. **Install dependencies**

   ```bash
   cd word-addin && pnpm install
   ```

2. **Set environment variables**

   Webpack loads `word-addin/.env` automatically for local development. Copy the example file or create it directly:

   ```bash
   # word-addin/.env.development
   REACT_APP_API_BASE_URL=https://localhost:3000
   ```

   - `REACT_APP_API_BASE_URL` — the backend **origin** (no `/api`; same meaning as the web frontend's `NEXT_PUBLIC_API_BASE_URL`). The add-in calls `<origin>/api/...` and reads its sign-in config from `<origin>/config`. No identity values (tenant, client id, scope) are baked into the bundle.

   > **Mixed content / HTTPS:** Word serves the task pane over HTTPS (`https://localhost:3000`), and its WebView blocks plain-HTTP requests to the local backend. So in development the bundle points at the dev server itself (`https://localhost:3000`), which proxies `/api` and `/config` to `API_PROXY_TARGET` (default `http://localhost:3001`) — `dev.sh` sets this up. Same-origin calls also avoid the backend's CORS allow-list, which only admits `FRONTEND_URL`.

   Existing shell variables take precedence over `.env`, which keeps CI and deployed builds configurable without modifying the file. Production builds continue to require their values from the deployment environment.

   `scripts/dev.sh` regenerates `.env` from the frontend configuration while preserving explicit add-in overrides. If you edit `.env` while webpack is running, restart the add-in dev server because the file is loaded only at startup.

3. **Trust the dev SSL certificate (one time only)**

   The dev server runs on `https://localhost:3000` with a self-signed certificate. Word refuses to load add-ins over untrusted HTTPS. Install the trusted cert once:

   ```bash
   npx office-addin-dev-certs install
   ```

   Restart Word after installing.

4. **Start the Mike backend**

   From the `word-addin` directory:

   ```bash
   (cd ../backend && pnpm dev)
   ```

5. **Start the add-in and sideload into Word**

   ```bash
   pnpm start
   ```

   This runs `office-addin-debugging start manifest.xml`, which starts the webpack dev server on `https://localhost:3000` **and** automatically opens Word with the add-in sideloaded. The task pane appears under **Home → Mike Legal AI → Mike**.

---

## Sideloading manually (if `npm start` does not auto-load)

### Word desktop — macOS

```bash
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

Restart Word, then: **Insert → Add-ins → My Add-ins → Mike**

### Word on the web

**Insert → Add-ins → Upload My Add-in** → select `manifest.xml`

> **Caveat — the pane will silently fail to load in a normal browser.** Word on the web is a *public* origin (`word-edit.officeapps.live.com`) and the dev pane is `https://localhost:3000`; Chrome's Local Network Access checks block a public page from embedding a localhost iframe, with no visible error — the pane simply never appears. This affects dev sideloads only (a deployed add-in on a public HTTPS host is unaffected). To test against real Word on the web locally, start a browser with those checks disabled. (Upstream ships a Playwright launcher for this in `e2e-live/`; it is not included in this fork.)

The manifest requires `WordApi 1.6`, which includes the tracked-change inspection, accept, and reject APIs used by assistant edit cards. Word will not activate the add-in on a host that does not satisfy that requirement set.

## Production build

Production builds fail fast unless every service endpoint and the deployed add-in URL are explicit. This prevents publishing a bundle that silently calls localhost.

```bash
cd word-addin
REACT_APP_API_BASE_URL=https://api.example.com \
REACT_APP_WEB_APP_URL=https://app.example.com \
WORD_ADDIN_PUBLIC_URL=https://word.example.com \
pnpm build
```

The build writes the task-pane assets (`taskpane.html`, `commands.html`, `auth-dialog.html`) and a deployable, URL-rewritten manifest to `dist/`. The checked-in `manifest.xml` remains the localhost sideloading manifest.

If the add-in is hosted on a different origin than `FRONTEND_URL`, the backend's CORS allow-list (`backend/src/app.ts`, `FRONTEND_URL` only) will block its API calls — serve the add-in from the backend's origin or extend the allow-list (not done in this fork yet).

---

## Features

### Chat

Ask any question about the open document. The add-in sends Word conversations to the dedicated `POST /word-chat` route with the active document in `document_context`. That route adds the Word-specific system prompt server-side, while persisted user messages contain only the text the user typed. Responses stream in real time.

Chat storage defaults to **Cloud**. Open **Settings** from the hamburger menu to switch to **This device only**, which bypasses server chat persistence and stores document-scoped conversations in IndexedDB. Switching locations does not copy or delete existing conversations; Chat History displays the currently selected location. Cloud storage requires the `20260809_01_word_addin_chats.sql` backend migration on existing databases (fresh databases receive the same tables from `backend/schema.sql`).

The composer mirrors the web assistant controls:

- **Add documents** opens the same library-style selector used by the web assistant. Search and select files, templates, or project documents, or upload new files from inside the modal; confirmed documents appear as removable chips and are attached to the next message.
- **Add workflows** opens the assistant workflow picker. The selected workflow appears as a removable chip and is attached to the next message.
- **Model** opens the same grouped Anthropic, Google, OpenAI, and dynamically discovered Azure OpenAI choices used by the web app.

The chat header and composer float over the message surface. Use **New chat** to clear the current conversation, **Chat history** to reopen a saved conversation, and the hamburger menu to access Quick Actions, Workflows, or Sign out.

When an answer proposes document edits, it streams each change using `<original>`, `<replacement>`, and `<reason>` tags. The task pane hides those transport tags, renders edit cards immediately, applies sealed edits to Word as tracked changes, and provides **Accept** and **Reject** controls for review.

### Quick Actions

Quick Actions are shortcuts that prepare the Assistant rather than running a separate execution screen. Selecting one attaches its linked workflow and fills the composer with a complete starting prompt; the user can review or edit that prompt before sending it.

The built-in actions are **Proofread**, **Compare documents**, **Extract key terms**, and **Draft from template**. Open **Quick Actions** from the hamburger menu to inspect each action's prompt and linked workflow or hide it from the Assistant's initial view.

### Workflows

Open **Workflows** from the hamburger menu to browse assistant workflows. Editable workflows use the same Tiptap Markdown editor as the web app, with rich-text formatting, tables, raw Markdown mode, and automatic saving. Use the header **+** button to create an assistant workflow, optionally importing its instructions from a `.md` or `.markdown` file. The **Use** action returns to Assistant and attaches the selected workflow to the next message.

---

## Signing in

The pane reads the backend's `GET /config` and follows its `authProvider`:

- **`entra`** (production) — **Sign in with Microsoft**. The add-in uses MSAL.js (`@azure/msal-browser`) to get an access token for the backend API scope `api://<backend-client-id>/access_as_user` (served by `/config` as `entra.apiScope`), for the tenant and client application in `/config` (`entra.tenantId`, `entra.clientId` — the **web frontend's app registration**). The backend validates it with its unchanged Entra validator (`backend/src/lib/auth/providers/entra.ts`), exactly like the web frontend's token.
  - **Nested App Authentication (NAA)** when the host supports the `NestedAppAuth 1.1` requirement set (current Microsoft 365 Word on Windows, Mac, and the web): MSAL brokers through the account already signed in to Office — usually silent single sign-on, otherwise a host-managed sign-in/consent prompt.
  - **Office dialog fallback** on older hosts: the pane opens `auth-dialog.html` with `displayDialogAsync`; that page runs MSAL's redirect sign-in and posts the token back with `messageParent`.
  - Tokens stay in MSAL's cache (NAA: the host; fallback: `localStorage`) and are renewed silently; a 401 forces one silent renewal, then drops back to the sign-in screen. **Sign out** clears the add-in's session and suppresses silent SSO until the next explicit sign-in (under NAA the Office account itself stays signed in to Office).
- **`local`** (development only) — an email-only form that calls `POST /api/auth/local-login`, like the web frontend's local mode.
- **`supabase`** — not supported by the add-in in this fork; the pane explains this instead of offering a form.

### Entra app registration (one-time, by an admin)

The add-in reuses the **frontend app registration** (the client id the backend serves as `entra.clientId`; KV `entra-client-id`), which already has delegated access to the backend API's `access_as_user` scope. On that registration, under **Authentication → Single-page application**, add these redirect URIs for each host the add-in is served from:

| Purpose | Redirect URI (SPA platform) |
|---|---|
| NAA broker | `brk-multihub://localhost:3000` (dev) / `brk-multihub://<add-in host>` (prod) |
| Dialog fallback | `https://localhost:3000/auth-dialog.html` (dev) / `https://<add-in host>/auth-dialog.html` (prod) |

Notes:
- `<add-in host>` is the host (and port, if any) of `WORD_ADDIN_PUBLIC_URL`, without a path — e.g. `brk-multihub://word.example.com`.
- The backend API registration must expose `access_as_user` and the frontend registration must have it in **API permissions** with admin consent (the install script `scripts/install/create-entra-apps.ps1` already sets this up for the web app; nothing new is needed for the add-in).
- The backend needs `entra-tenant-id`, `entra-client-id`, and `entra-backend-client-id` (Key Vault or the matching `ENTRA_*` env vars) — the same values the web sign-in uses; `/config` reads them env-first, Key Vault second.
- Using a **separate** app registration for the add-in instead is possible but not wired: `/config` would need to serve its client id, and it would need its own `access_as_user` permission + consent.

---

## Tests

```bash
cd word-addin
pnpm typecheck
```

Upstream's hermetic Playwright suite (`e2e/`) and live Word-on-the-web demo recorders (`e2e-live/`) are bootstrapped against Supabase auth and are **not** included in this fork (deferred with the rest of upstream's Playwright/e2e tooling).

---

## Troubleshooting

**Word shows "The content is blocked because it isn't signed by a valid security certificate" — including when it worked before**
This is *certificate trust drift*, and it will eventually happen to every returning developer: the dev certificate expires after ~30 days, and the tooling then silently regenerates it **with a new signing CA** (the webpack dev server does this on startup). Your OS keychain still trusts only the *old* CA, so Word rejects the pane — while `npx office-addin-dev-certs verify` misleadingly reports "trusted", because it only checks that a CA *by that name* exists, not that it signed the current certificate. `npx office-addin-dev-certs install` then refuses to reinstall for the same reason.

`bash scripts/dev.sh` now detects and repairs this automatically (it verifies the real chain against the OS trust store). To fix it by hand on macOS:

```bash
# 1. Ground truth — does the OS trust the cert actually being served?
security verify-cert -c ~/.office-addin-dev-certs/localhost.crt -p ssl -s localhost

# 2. If that fails: force a real reinstall (approve the keychain prompt)
npx office-addin-dev-certs uninstall
npx office-addin-dev-certs install

# 3. Verify step 1 again; if still untrusted, trust the current CA directly:
security add-trusted-cert -r trustRoot \
  -k ~/Library/Keychains/login.keychain-db ~/.office-addin-dev-certs/ca.crt
```

Then **fully quit Word (Cmd-Q)** — its webview caches trust decisions — and relaunch with `pnpm start`.

**`pnpm start` fails with `EEXIST: file already exists, link 'manifest.xml' -> …/wef/….manifest.xml`**
A previous run exited without deregistering (crash, Ctrl-C) and left the sideload hard-link behind. `pnpm start` now clears this automatically via its `prestart` hook; if you hit it anyway, run `pnpm run stop` and retry.

**`pnpm start` / `dev.sh` complains port 3000 is in use**
The add-in dev server and the manifest are hardwired to `https://localhost:3000`, which collides with the Mike web app's dev server. Find the holder with `lsof -nP -iTCP:3000 -sTCP:LISTEN` and stop it (usually `pnpm dev` in `frontend/`).

**The pane never appears in Word on the web**
See the caveat under [Word on the web](#word-on-the-web) — Chrome's Local Network Access checks silently block the localhost iframe.

**Add-in shows blank after the cert is trusted**
Right-click the task pane → **Inspect** and check the console for errors. A common cause is a wrong `REACT_APP_API_BASE_URL` — the bundle falls back to `http://localhost:3001` if the env var was not exported before `pnpm start`.

**Sign-in fails or the API answers 401**
- "Microsoft sign-in is not configured…" — the backend's `/config` has no tenant / client id / API scope; set `entra-tenant-id`, `entra-client-id`, `entra-backend-client-id` (Key Vault or `ENTRA_*` env).
- `AADSTS50011` (redirect URI mismatch) — add the `brk-multihub://…` and `…/auth-dialog.html` SPA redirect URIs above to the frontend app registration.
- 401 "Invalid audience" / "Invalid tenant" from the API — the token was issued for a different API or tenant; check `entra.apiScope` / `entra.tenantId` in `/config`.

**Tracked edit review is unavailable**
The add-in requires WordApi 1.6. Confirm the Word host and build support that requirement set; otherwise use a supported Microsoft 365 Word client.

**Document upload fails**
- Confirm the Mike API is running (`npm run dev` in `backend/`) and reachable at `http://localhost:3001`
- Confirm the API's configured object-storage bucket exists
- Check the backend logs for the specific error

**Workflows page shows "No workflows found"**
Workflows are fetched from `GET /workflows` on the Mike backend. Confirm the backend is running and that at least one workflow exists in the database.
