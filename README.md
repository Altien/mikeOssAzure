# Mike

![Mike](https://mikeoss.com/link-image.jpg)

Mike or MikeOSS is a legal AI platform that is able to assist you with document
review, drafting and legal research.

It has a Next.js frontend, an Express backend, selectable Supabase or SQLite
persistence/authentication, selectable Cloudflare R2 or SQLite file storage,
and configurable AI model providers.

Website: [mikeoss.com](https://mikeoss.com)

## Features

- **Document review, drafting, and research** — project and standalone
  document chat, tabular review, workflows, document versions, and
  DOCX/PDF/Markdown handling (Markdown documents render formatted in the
  preview panels). Redlining works on PDFs too: the assistant
  asks for the original Word file, or converts the PDF into an editable
  `.docx` copy (original untouched) using layout-preserving text
  extraction, then applies tracked changes to the copy.
- **Selectable infrastructure providers** — run fully self-contained on
  SQLite (database, auth, and file storage) with Node 22+, or use the
  upstream Supabase + Cloudflare R2 profile. See
  [deployment modules](docs/deployment-modules.md).
- **Optional deployment modules** — enable only the product surfaces you
  want with the `MIKE_ENABLED_MODULES` allow-list.
- **Model orchestration** — Anthropic, Gemini, OpenAI, and Kimi cloud
  models, the full OpenRouter catalog with a per-user API key, local
  OpenAI-compatible servers (with streaming tool calling and reasoning
  channels), and multi-model committee orchestration. If the
  requested or default model has no usable API key, chat automatically
  falls back to a configured model that does. See
  [model orchestration](docs/model-orchestration.md).
- **Legal monitors** — scheduled classify → gap-check → memo-draft → digest
  pipelines over RSS/Atom feeds and connector sources, with run history,
  captured documents, email alerts, and bundled presets (Fintech GC
  Regulatory Digest, trademark monitoring). See
  [legal monitor sources](docs/legal-monitor-sources.md).
- **Playbooks** — reusable contract-review playbooks with versioning, run
  history, Word export, and document imports. See
  [playbooks](docs/playbooks.md).
- **Prompt library** — per-user saved prompts plus a built-in example
  library, available from the assistant composer. See
  [prompt library](docs/prompt-library.md).
- **Gmail integration** — per-user OAuth connection for mailbox search and
  reading in chat, importing emails as DOCX documents, and sending Monitor
  alerts. See [Gmail integration](docs/gmail-integration.md).
- **USPTO patent and trademark connector** — a managed local MCP connector
  that runs the open-source `patent_mcp_server` with per-tool enablement
  and audit controls. See
  [enabling the patent MCP server](docs/patent-mcp-connector.md).
- **Microsoft Word add-in** — task-pane add-in for chat, tracked edits,
  comments, project documents, workflows, tabular reviews, local models,
  and committee models. See [Word add-in setup](docs/word-addin.md).
- **CourtListener and Ironclad integrations** — US case-law lookup and
  citation verification; contract search and import from Ironclad CLM.
- **Account controls** — TOTP multi-factor authentication, per-user feature
  flags, dark mode, per-user model API keys, and support feedback.

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, provider-neutral data access, document processing, model routing, and database schema
- `backend/schema.sql` - Supabase schema for fresh databases
- `backend/migrations/` - dated, incremental schema migrations; on an existing database, apply the files dated after the Mike version you deployed
- `docker-compose.yml` - complete local Supabase, object-storage, email, frontend, and backend stack
- `word-addin/` - Microsoft Word task-pane add-in
- `docs/deployment-modules.md` - deployment profiles and optional-module allow-list
- `docs/model-orchestration.md` - local OpenAI-compatible and committee model setup
- `docs/legal-monitor-sources.md` - legal monitor feeds, connector sources, and presets
- `docs/playbooks.md` - contract-review playbooks
- `docs/prompt-library.md` - saved prompts and the built-in example library
- `docs/gmail-integration.md` - Gmail OAuth, email import, assistant tools, and Monitor delivery
- `docs/patent-mcp-connector.md` - enabling the managed USPTO patent and trademark MCP connector
- `docs/word-addin.md` - Word add-in development, sideloading, and deployment

## Quick start with Docker

The bundled `docker-compose.yml` runs Mike with local Supabase, RustFS object
storage, Mailpit, and the frontend/backend. It is an alternative to the
self-contained SQLite profile described below.

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Set `DOWNLOAD_SIGNING_SECRET` and `USER_API_KEYS_ENCRYPTION_SECRET` in
`backend/.env` to separate values generated with `openssl rand -hex 32`. Add a
hosted model API key unless you plan to use Ollama exclusively, then start the
stack:

```bash
docker compose up --build
```

Open `http://localhost:3000`. Mailpit is available at
`http://localhost:8025`, and the RustFS console is at
`http://localhost:9001`.

Ollama models are discovered dynamically from the host. Pulling a model makes
it available under the Local model group after refresh:

```bash
ollama pull qwen3.6
```

Notes:

- Models that support tool-calling can drive the full assistant; ones that
  don't (e.g. `phi3:mini`) still work for plain chat — the backend retries
  without tools automatically.
- Quality and speed depend on the local model; large models are noticeably
  slower for tabular review (which runs the model across many cells).

The Supabase JWT secret and the anon/`service_role` keys baked into
`docker-compose.yml` / `.env.example` are the well-known Supabase **local demo**
values — convenient for localhost, but regenerate them before exposing this
anywhere.

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Supabase access, document processing, and database
  schema
- `word-addin/` - Microsoft Word task pane add-in (currently in beta)
- `backend/schema.sql` - Supabase schema for fresh databases
- `backend/migrations/` - dated, incremental schema migrations for existing
  deployments
- `docker-compose.yml` - complete local application and infrastructure stack
- `docs/` - testing, deployment safety, and feature-specific guides

## Microsoft Word add-in (Beta)

The Mike Word add-in is currently in beta. It brings Mike into a Word task
pane for chatting about the open document, running quick actions and workflows,
attaching supporting files, and applying suggested changes as tracked edits.

See the [Word add-in guide](word-addin/README.md) for prerequisites, local
development, sideloading, and troubleshooting instructions.

## System Workflows

Mike's system assistant and tabular review workflows are maintained in the
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository.

## Manual or production deployment

Use this path when connecting Mike to managed Supabase and S3-compatible
storage rather than the infrastructure bundled in Docker Compose.

### Prerequisites

- Node.js 20 or newer; Node.js 22 or newer for the SQLite providers
- npm
- git
- For the Supabase profile: a Supabase project, and a Cloudflare R2 bucket, MinIO bucket, or another S3-compatible bucket
- At least one supported model provider API key (Anthropic, Google Gemini, or OpenAI), or a local OpenAI-compatible server
- Optional: a CourtListener API token for case law lookup and citation verification
- Optional: [`uv`](https://docs.astral.sh/uv/getting-started/installation/) for the USPTO patent/trademark connector
- LibreOffice installed locally if you need DOC/DOCX to PDF conversion

### Database setup

The SQLite profile needs no schema step: the database is created automatically on
first boot (see [Run Locally](#run-locally)).

For a new Supabase database, open the Supabase SQL editor and run:

```sql
-- copy and run the contents of:
-- backend/schema.sql
```

The schema file is for fresh deployments and already includes the latest
database shape.

For an existing database, do not run the full schema over production data.
Apply the files in `backend/migrations/` dated after the deployed Mike version,
in filename order. Migration files use the format `YYYYMMDD_<name>.sql` and are
written to be safe to re-run.

### Environment

Copy the maintained examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
MIKE_ENABLED_MODULES=all

# Self-contained local profile.
MIKE_DATABASE_PROVIDER=sqlite
MIKE_AUTH_PROVIDER=local
MIKE_STORAGE_PROVIDER=sqlite
SQLITE_DB_PATH=./data/mike.sqlite
SQLITE_STORAGE_PATH=./data/mike-files.sqlite

# Supabase Auth/database and R2 storage instead of the SQLite block above.
# These remain the upstream-compatible defaults documented in
# backend/.env.example.
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret

# Optional: enables Kimi K3/K3-256K as cloud model options.
KIMI_API_KEY=your-kimi-code-api-key

# Optional: enables CourtListener case law and citation tools.
COURTLISTENER_API_TOKEN=your-courtlistener-token

# Optional: use locally imported CourtListener bulk data for faster case reads.
COURTLISTENER_BULK_DATA_ENABLED=false

# Optional: where support-form feedback is emailed when RESEND_API_KEY is set.
SUPPORT_INBOX_EMAIL=you@example.com

# Optional: enables the Ironclad CLM integration (contract search + import).
IRONCLAD_API_KEY=your-ironclad-bearer-token
IRONCLAD_BASE_URL=https://na1.ironcladapp.com
# Optional: actor email for client-credentials tokens (defaults to the
# signed-in Mike user's email per request).
IRONCLAD_AS_USER_EMAIL=you@example.com

# Optional: enables per-user Gmail search, import, and Monitor sending.
GMAIL_CLIENT_ID=your-google-oauth-client-id
GMAIL_CLIENT_SECRET=your-google-oauth-client-secret
GMAIL_REDIRECT_URI=http://localhost:3001/integrations/gmail/oauth/callback

# Optional: unlocks USPTO Open Data Portal and TSDR tools in the managed
# patent/trademark connector. Public search tools work without these keys.
USPTO_API_KEY=your-uspto-open-data-portal-key
TSDR_API_KEY=your-uspto-tsdr-key

# Optional: per-request LLM timeout in milliseconds (default 120000). Raise
# for long reasoning-heavy turns such as large-document redlines.
LLM_REQUEST_TIMEOUT_MS=600000

# Optional: Ed25519 seed (openssl rand -hex 32) used to sign project export
# manifests. Unset means manifests export unsigned.
MANIFEST_SIGNING_KEY=
```

`FRONTEND_URL` must exactly match the origin the browser uses to reach the
frontend — it is enforced for CORS, so a mismatched port or host makes every
API request from the browser fail with a network error.

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_MIKE_AUTH_PROVIDER=local

# Supabase profile instead of NEXT_PUBLIC_MIKE_AUTH_PROVIDER=local:
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-supabase-anon-key
```

Next.js embeds `NEXT_PUBLIC_*` values in the browser bundle at build time, so
they must be set when running `npm run build --prefix frontend` — setting them
only when starting an already-built application is too late.
`NEXT_PUBLIC_API_BASE_URL` is always required for production builds; the
Supabase profile (`NEXT_PUBLIC_MIKE_AUTH_PROVIDER` unset or `supabase`)
additionally requires `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` from the Supabase project
dashboard. Production builds fail with a list of missing variables instead of
producing a bundle that cannot connect to the backend.

On the Supabase profile, the Supabase values come from the project dashboard.
Use the project URL for `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, the service
role key for the backend `SUPABASE_SECRET_KEY`, and the anon/public key for
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`. If your Supabase project shows
multiple key formats, use the legacy JWT-style anon and service role keys
expected by the Supabase client libraries.

See [optional deployment modules](docs/deployment-modules.md) for the module
allow-list and complete upstream/local deployment examples.

Provider keys are only needed for the models, legal research, and email
features you plan to use. Model provider keys and the CourtListener token can be
configured in `backend/.env` for the whole instance, or per user in
**Account > Models & API Keys**. If a provider key is present in
`backend/.env`, that provider is available by default and the matching browser
API key field is read-only.

For local OpenAI-compatible models and committee orchestration, see
`docs/model-orchestration.md`.

Supabase Auth, rather than the Mike backend, sends signup, email-change, and
password-recovery messages. Configure production SMTP in the Supabase dashboard
if those flows are enabled. Mike does not require a Resend API key.

Mike hashes a document version's bytes (SHA-256) whenever it writes them.
`GET /projects/:projectId/export` returns a manifest of those hashes plus the
accept/reject trail. To check a file you were given, run
`shasum -a 256 lease.docx` and compare it to the manifest. Versions written
before this shipped carry a `null` hash, so they read as unverifiable rather
than as falsely verified.

Soft-deleted versions stay in the manifest, carrying their `deleted_at`. A
trail that dropped them would be a weaker attestation, but it does mean the
filename and timestamps of a deleted version are visible to anyone with access
to the project.

The manifest also carries a SHA-256 `digest` over its own body, meaning
everything except `digest` and `signature`. Serialise that body with object
keys sorted, array order kept, and no whitespace, and you can recompute the
digest from parsed JSON.

Set `MANIFEST_SIGNING_KEY` to sign that digest. The signature is a raw Ed25519
signature over the bytes `mike-project-manifest-v1`, a NUL byte, then the
digest bytes, checkable with any Ed25519 library:

```js
crypto.verify(null,
  Buffer.concat([Buffer.from("mike-project-manifest-v1\0"),
                 Buffer.from(manifest.digest.value, "hex")]),
  publicKey, Buffer.from(manifest.signature.value, "hex"));
```

Take `publicKey` from `GET /manifest-signing-key`, not from the manifest.
Whoever edits a manifest can re-sign it with a key of their own, so the
embedded copy shows consistency, never provenance.

## Install

Install each app package:

```bash
npm install --prefix backend
npm install --prefix frontend
npm install --prefix word-addin
```

The backend depends on `xlsx` served from the SheetJS CDN rather than the npm
registry. npm 12 and newer blocks remote tarball dependencies by default; the
committed `backend/.npmrc` (`allow-remote=root`) re-enables them for the
backend's direct dependencies, so the install works out of the box. Older npm
versions ignore the setting.

## Run Locally

Start the backend and frontend in separate terminals:

```bash
npm run dev --prefix backend
```

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

The SQLite database and file store are created automatically on first boot at
`SQLITE_DB_PATH` / `SQLITE_STORAGE_PATH`; no seed database or migration step is
required for the local profile.

### Microsoft Word

MikeOSS includes a Word task-pane add-in for chat, tracked edits, comments,
project documents, workflows, tabular reviews, local models, and committee
models. See [Word add-in setup](docs/word-addin.md) for HTTPS development,
sideloading, and production deployment instructions.

## First Run

1. Sign up in the app. The selected authentication provider manages the
   account and session; the local profile stores them in `SQLITE_DB_PATH`.
2. If you did not set provider keys in `backend/.env`, open
   **Account > Models & API Keys** and add an Anthropic, Gemini, or OpenAI API
   key.
3. To use legal research tools, add a CourtListener token in `backend/.env` or
   **Account > Models & API Keys**.
4. Create or open a project and start chatting with documents.

## Legal Monitors

Mike can run scheduled monitors that pull RSS/Atom feeds and connector
sources, classify new items, and escalate material developments into saved
reports and email alerts. Open **Monitors** to create a monitor from scratch
or install a bundled preset (**Fintech GC Regulatory Digest**, trademark
monitoring). Each run keeps history, deduplicates and checkpoints items, and
can capture source documents. See the
[legal monitor sources guide](docs/legal-monitor-sources.md).

**Library knowledgebase (opt-in).** Enable **Save run reports to Library** on
a monitor to maintain a living Markdown knowledgebase in
**Library › Legal Monitors**. Each completed run weaves new developments into
the document — still-valid knowledge is preserved, duplicates are merged, and
superseded facts are corrected in place with dated notes — so the monitor
keeps learning instead of starting over. Updates are versioned, and the
knowledgebase is an ordinary Library file: the assistant can read it in chat
and you can attach it back to the monitor as reference context.

## Playbooks

Reusable contract-review playbooks live under **Playbooks**: define positions
once, run them against documents in chat via the playbook picker, export
results to Word, and import existing playbook documents. Playbooks are
versioned and keep run history. See [playbooks](docs/playbooks.md).

## Prompt Library

**Prompts** stores per-user saved prompts alongside a built-in example
library, and the assistant composer can insert them directly. See the
[prompt library guide](docs/prompt-library.md).

## CourtListener Integration

Mike can use CourtListener for US case law citation verification, case fetching,
targeted opinion search, and case-law panels in assistant responses.

To enable live CourtListener access, set `COURTLISTENER_API_TOKEN` in
`backend/.env` and restart the backend. Users can also add their own
CourtListener token from **Account > Models & API Keys** when the instance does
not provide one globally.

On the Supabase profile, fresh databases created from `backend/schema.sql`
already include the CourtListener support tables. Existing deployments should
apply the matching dated migration in `backend/migrations/` before enabling the
feature.

Bulk data is optional. When `COURTLISTENER_BULK_DATA_ENABLED=true`, Mike first
tries locally imported data before falling back to CourtListener's API:

- citation metadata is read from `public.courtlistener_citation_index`
- case cluster metadata is read from `public.courtlistener_opinion_cluster_index`
- cached opinion JSON is read from the object-storage prefix
  `courtlistener/opinions/by-cluster/{clusterId}/{opinionId}.json`

If you do not import bulk data, leave `COURTLISTENER_BULK_DATA_ENABLED=false`;
live CourtListener tools still work with a valid token, subject to
CourtListener rate limits.

## Ironclad Integration

Mike can connect to an Ironclad CLM account so contracts stored in Ironclad
can be used as data sources. Set `IRONCLAD_API_KEY` (and optionally
`IRONCLAD_BASE_URL` / `IRONCLAD_AS_USER_EMAIL`) in `backend/.env` and restart
the backend.

Once configured:

- **Import** records as Mike documents from any document picker via
  **Import from Ironclad**: search your records, pick an attachment (the
  signed copy or any other attachment on the record), and import it into a
  project or as a standalone document. Imported contracts work everywhere
  documents do — chat, tabular review, versions (recorded with source
  `ironclad`).
- **Chat tools**: the assistant can search Ironclad records, inspect record
  metadata and attachments, and import contracts mid-conversation when it
  helps answer a question.

OAuth scopes required on the Ironclad token: `public.records.readRecords`
and `public.records.readAttachments`. Tokens from the client-credentials
grant also need an actor user — set `IRONCLAD_AS_USER_EMAIL`, or Mike sends
the signed-in user's email as `x-as-user-email`.

## Gmail Integration

Mike can optionally search and read a connected Gmail mailbox, import an email
as a Mike DOCX document, and send material Monitor alerts from that mailbox.
Configure the Google OAuth client in `backend/.env`, then enable and connect the
mailbox under **Account > Features > Email Integration**. See the complete
[Gmail integration guide](docs/gmail-integration.md).

## Patent And Trademark Connector

Mike includes a managed local connector for the open-source
[`patent_mcp_server`](https://github.com/riemannzeta/patent_mcp_server).
To enable it:

1. Install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) and
   restart the backend.
2. Open **Account > Connectors** and select **USPTO**.
3. Wait for the first launch to download the pinned server (about a minute),
   then review the imported tools in the connector details.

Mike runs the pinned server over stdio and imports its tools into the existing
per-tool enablement and audit controls. Public patent and trademark search
tools work without credentials; add `USPTO_API_KEY` / `TSDR_API_KEY` to unlock
the credentialed data sources. See the complete
[patent MCP server guide](docs/patent-mcp-connector.md).

## Multi-Factor Authentication

Mike supports local TOTP MFA (RFC 6238) with any standard authenticator app.
Enroll under **Account > Security**, then optionally enable **Require
verification on login**. Sessions are split into password-only (aal1) and
verified (aal2); API routes reject aal1 sessions until the TOTP code is
verified. Removing your last verified factor automatically turns the
login requirement off. `USER_API_KEYS_ENCRYPTION_SECRET` must be set — it
also encrypts the TOTP secrets at rest.

## Troubleshooting

**`npm install --prefix backend` fails with `Fetching packages of type
"remote" have been disabled`.** Your npm config overrides the committed
`backend/.npmrc`. Run the install with `npm install --prefix backend
--allow-remote=root`, or remove the conflicting `allow-remote` setting from
your user-level npmrc.

**Every login or API call fails with "Failed to fetch".** `FRONTEND_URL` in
`backend/.env` does not match the browser origin of the frontend (protocol,
host, and port must be identical). Fix it and restart the backend.

**The backend exits with a `node:sqlite` error.** The SQLite providers require
Node 22 or newer. Check `node --version`.

**Sign-up confirmation email never arrives (Supabase profile).** Confirmation
emails are sent by Supabase Auth, not by Mike. For local development, the
simplest fix is to disable email confirmation in **Supabase > Authentication >
Providers > Email**. For production, configure custom SMTP in Supabase; the
built-in mailer is heavily rate-limited and may be restricted on newer projects.

**The model picker shows a missing-key warning.** Add a key for that provider in
**Account > Models & API Keys**, configure the provider key in `backend/.env`,
or configure a local OpenAI-compatible model.

**CourtListener tools say the API token is missing.** Set
`COURTLISTENER_API_TOKEN` in `backend/.env`, or add a CourtListener token in
**Account > Models & API Keys** for the signed-in user. Restart the backend
after changing `.env`.

**CourtListener bulk lookup is not returning local results.** Confirm
`COURTLISTENER_BULK_DATA_ENABLED=true`, the two CourtListener tables have been
populated, and opinion JSON exists in object storage under
`courtlistener/opinions/by-cluster/`. If bulk data is unavailable, Mike falls
back to the live API when a token is configured.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the
backend so document conversion commands are available on the process path.

## Useful Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```

## Documentation

- [Documentation index](docs/README.md)
- [Local development](docs/local-development.md)
- [Manual and production deployment](docs/deployment.md)
- [Optional deployment modules](docs/deployment-modules.md)
- [Model orchestration](docs/model-orchestration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [CourtListener integration](docs/courtlistener.md)
- [Microsoft Word add-in](word-addin/README.md)
- [Tamper-evident exports](docs/tamper-evident-exports.md)
- [Safe local testing](docs/safe-local-testing.md)
- [End-to-end testing and CI](docs/e2e-ci.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Mike is available under the [GNU Affero General Public License v3.0](LICENSE).
