# MikeOSS Word Add-in

The Word add-in puts MikeOSS chat, project documents, workflows, tabular
reviews, risk checks, tracked edits, comments, and document writing in a Word
task pane. It uses the same SQLite-backed backend, user accounts, API keys,
local models, and committee models as the main application.

The implementation was adapted from the [Mike Word add-in](https://github.com/ebubekirkupe/mike)
and aligned with this repository's current API and authentication contracts.

## Prerequisites

- Node.js 22 or later.
- The MikeOSS backend running on `http://127.0.0.1:3001`.
- Microsoft Word on Windows or macOS, or Word on the web.
- A MikeOSS account. If MFA on login is enabled, keep the authenticator
  available when signing into the task pane.

Office task panes must be served over HTTPS. Microsoft permits a trusted
self-signed certificate for development; production and Office on the web
require HTTPS hosting. See Microsoft's [Office add-in requirements](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/requirements-for-running-office-add-ins).

## Local setup

From the repository root:

```bash
cd word-addin
npm install
npm run install-certs
npm run dev
```

The task pane is served at `https://localhost:3002/taskpane.html`. During
development, webpack proxies same-origin requests under `/api` to
`http://127.0.0.1:3001`. This avoids HTTPS-to-HTTP mixed-content failures in
Word. Override the backend proxy target when needed:

```bash
MIKE_BACKEND_URL=http://127.0.0.1:3331 npm run dev
```

For a browser-only smoke test, `MIKE_USE_OFFICE_CERTS=false npm run dev` skips
the trusted Office CA and uses webpack's temporary certificate. Do not use that
mode for Word sideloading because Office must trust the task-pane certificate.

The backend and full web app still run normally:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

## Sideload the add-in

The manifest is [`word-addin/manifest.xml`](../word-addin/manifest.xml).

For automatic desktop sideloading, run this after installing the development
certificate:

```bash
cd word-addin
npm start
```

Stop the debugging registration when finished:

```bash
npm stop
```

Microsoft recommends stopping through the debugging tool because closing Word
or the terminal does not remove the development registration. See
[test and debug Office add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/test-debug-non-local-server).

For Word on the web, start the HTTPS development server, open a document, then
choose **Home > Add-ins > More Settings > Upload My Add-in** and upload
`manifest.xml`. Microsoft documents the complete flow in
[Sideload Office Add-ins for testing](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing).

## Sign in and models

Sign in with the same email and password used by MikeOSS. The task pane also
supports the account's six-digit TOTP challenge when MFA on login is enabled.

The model menu merges MikeOSS's built-in models with `/user/models`, so local
OpenAI-compatible models and committee definitions from
`MIKE_MODEL_CONFIG_JSON` appear automatically. Configure API keys in the main
MikeOSS **Account > API Keys** page. Configure local and committee models as
described in [`docs/model-orchestration.md`](model-orchestration.md); no model
configuration is duplicated in the add-in.

## Word behavior

- **Current doc** sends up to 40,000 characters of the open document as chat
  context.
- An active Word selection is re-read when a message is sent and scopes the
  model's edit or write instructions.
- **Track** applies exact-text replacements while Word change tracking is on
  and adds the model's reason as a comment.
- **Comments** anchors advisory comments to matching text without replacing it.
- **Write to this doc** accepts structured `writes` output and inserts light
  markdown at the selection, after it, or at the end.
- Generated files use an authenticated exchange for a five-minute signed URL
  before invoking Word's `ms-word:` handler. The ordinary download endpoint
  remains bearer protected.

## Production hosting

Build the static task pane with:

```bash
API_BASE_URL=https://mike.example.com/api \
MIKE_WEB_URL=https://mike.example.com \
npm run build
```

Deploy `word-addin/dist` over HTTPS. Update every `https://localhost:3002`
entry in `manifest.xml` to the deployed origin, then rebuild and distribute
that manifest through your Microsoft 365 deployment method. If the backend is
mounted at the same origin without an `/api` prefix, set `API_BASE_URL` to that
origin instead.

Validate the manifest before distribution:

```bash
npx office-addin-manifest validate manifest.xml
```

## Verification

```bash
cd word-addin
npm run typecheck
npm run build
npx office-addin-manifest validate manifest.xml

cd ../backend
npm run build
npm test
```

The add-in only stores its MikeOSS session token and UI preferences in Office
task-pane `localStorage`. Documents, chats, workflows, model settings, and API
keys remain in the existing MikeOSS backend and SQLite storage.
