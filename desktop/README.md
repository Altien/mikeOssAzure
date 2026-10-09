# Mike desktop

The Electron shell hosts the existing Mike web product. It provides native
menus and shortcuts, window persistence, fenced OAuth popups, context menus
and downloads. It can connect to an explicitly chosen deployment or supervise
an isolated local workspace on Apple Silicon macOS.

This fork has no preselected upstream hosted service. First launch offers a
local workspace when its resources are present, or a deployment address.
Remote mode uses the deployment's runtime /config, sign-in and credential
policy, including Entra. The product gets no bridge capable of changing the
server address; that power stays with the shell's bundled connection pages.

## Local workspace

The local process order is PostgreSQL, numbered migrations and bundled
workflow installation, PostgREST, then the backend with its durable worker
thread. The backend serves the static frontend export, /config and /api on
http://127.0.0.1:42814. PostgreSQL uses port 42810 and PostgREST port 42812.
All listeners bind to loopback. Port conflicts fail startup.

Local login uses Dev's existing cookie-session provider. “Continue on this
Mac” enters a stable local guest profile and completes optional onboarding.
Separate local profiles can use the existing email-based local sign-in.
There is no GoTrue process, Supabase auth schema, RLS bootstrap, Next server,
Redis requirement, or frontend service key.

Mutable files live in ~/Library/Application Support/Mike/local:
pgdata/, storage/, logs/ and a private secrets.json. Auth/session/download
secrets are minted per install, persisted atomically and never regenerated
over an unreadable file. Quit stops workers and services before PostgreSQL.
Closing the window keeps the app in the dock, following the shell convention.

The launcher strips inherited model keys, Azure credentials, debugging,
proxy and telemetry settings from local child environments. It also prevents
dotenv loading. Explicit local settings are supplied by the supervisor.

## Provider configuration

Model credentials retain Dev's owner-managed policy. The guest button does
not enable personal secret editors. An operator may create local/operator-config.json
beside secrets.json with an explicit provider configuration, then restart:

```json
{
  "OPENAI_API_KEY": "operator-provided-key"
}
```

Set its permissions to owner-only (chmod 600). operator.js accepts only model
credential/catalog settings; it rejects auth, telemetry, database, network and
storage overrides. Inherited shell keys are ignored. Without configured
providers the workspace can still manage documents, projects and workflows;
model calls require an available provider. Remote deployments keep Key Vault
and their organisation policy.

## Build and run on Apple Silicon macOS

Use Node 24 and pnpm 11.1.2. The native fetch uses the pinned Postgres and
PostgREST builds and retains their verified notices. No Go toolchain is needed.

```bash
pnpm --dir backend install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm --dir desktop run local:fetch
pnpm --dir desktop run local:build
pnpm --dir desktop run start:local
```

local:build builds the backend, validates and bundles the workflow catalogue
and builds the static frontend with an isolated environment and same-origin
API base. Build-time catalogue downloads can use MIKE_WORKFLOWS_GITHUB_TOKEN;
that token is not included in runtime configuration. A local launch uses the
built backend and frontend/out directly. A packaged launch uses the same
files staged under resources/local-stack/app/backend, with the frontend in public/.

LibreOffice conversion requires /Applications/LibreOffice.app; the supervisor
uses its soffice binary when installed. Email-based password recovery and
cloud synchronisation do not apply to the local cookie-session provider.
Back up the entire local directory, including pgdata and secrets, together.

## Migration safety

Desktop calls the compiled canonical migrationLedger helper from the backend.
Fresh and upgraded databases execute the same numbered SQL; pgmigrations is
the sole applied-file history. There is no schema.sql manifest, duplicate
desktop ledger or silent baseline. Applied historical files without checksums
remain explicitly unverified. Changed/renamed history blocks startup for
inspection. See ../docs/deployment.md for status and explicit recovery.

The session advisory lock protects cooperating runners through SQL commits.
Historical migration files contain their own BEGIN/COMMIT, so an upgrade is
not guaranteed to roll back the entire batch on failure. Preserve the workspace
and inspect logs instead of deleting history or automatically marking updates.

## Validation

```bash
# Node tests; native upgrade coverage requires fetched PG and a built backend.
MIKE_REQUIRE_LOCAL_STACK=1 pnpm --dir desktop test
# Unsigned package used solely as a validation fixture:
pnpm --dir desktop run local:stage
pnpm --dir desktop run dist:local
pnpm --dir desktop run e2e:local
```

desktop.yml retains the Mac unit/real-PostgreSQL upgrade job and unsigned
packaged first-run/returning-user job. The native upgrade test installs the
pinned previous numbered Dev history, applies current files through the actual
desktop bootstrap and compares fresh/upgraded shapes. First-run E2E exercises
local login, projects, uploads, capability downloads, guest entry and persistence.
The separate flows E2E covers popup fencing, external links and downloads.

Tests use isolated profiles and artifacts; they must not use a person's real
workspace. Native UI/packaging results require the Mac runner and are not
implied by a Windows backend build. Signing, notarisation, distribution and
release remain separate operator actions; no publication runs in this CI.

## Remote mode and shell controls

```bash
pnpm --dir desktop start -- --server-url=https://your-mike.example.org
```

Explicit command-line or MIKE_SERVER_URL settings override saved choices.
Only the chosen product origin renders in the main window. Third-party
links leave the shell; OAuth popups retain their opener without the privileged
preload. Redirects and local-file navigation remain fenced. Downloads use
collision-safe names in Downloads. Cmd+1 through Cmd+5 mirror the main
navigation, Cmd+6 opens history, Cmd+, opens product settings and Cmd+Shift+,
opens the deployment chooser.

Local filesystem storage implements the existing provider contract, including
streaming, head/copy/list, exact-size signed PUT and expiring GET capabilities.
The later upstream StorageAdapter refactor (80136892) must preserve this
integration, Azure's private transport and lifecycle/claim fences.
