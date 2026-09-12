# Mike for Azure

Mike adapted to run on Microsoft Azure or on a local development stack
without hosted dependencies. This AGPL-3.0 fork is based on upstream
[Mike v0.3.0](https://github.com/willchen96/mike/releases/tag/v0.3.0).

The Azure edition adds Microsoft Entra ID, Azure Blob Storage, Azure
OpenAI, portable runtime configuration, Postgres migrations, and an
operator-facing `/install` configurator.

## Installation paths

### Local development

Use the local stack to run Postgres, PostgREST, and Azurite:

1. Install Node.js 22+, Corepack, Docker, and Docker Compose.
2. Follow [the local-stack runbook](docs/runbook-local-stack.md).

The package manager is pnpm:

```bash
corepack enable
cd backend
pnpm install --frozen-lockfile
cd ../frontend
pnpm install --frozen-lockfile
cd ..
docker compose -f docker-compose.dev.yml up -d
```

Then run `pnpm migrate:dev` and `pnpm dev` from `backend/`, and `pnpm dev`
from `frontend/`. The backend runs on `http://localhost:3001`; the frontend
runs on `http://localhost:3000`.

### Manual Azure deployment

For a self-hosted Azure installation, follow
[Deploying Mike to Azure — minimal self-host](docs/azure-prereqs.md).
It is the canonical installation guide and assumes a technical operator
comfortable with Azure CLI, Docker, PowerShell 7, and Entra administration.

Generic helper scripts in [`scripts/install/`](scripts/install/) automate
the error-prone Entra registration, redirect-URI, Azure OpenAI, and recovery
steps. They use the operator's current Azure login and contain no deployment
credentials.

## Connectors

Mike connects to the systems a legal team already works in — Slack and any
remote [MCP](https://modelcontextprotocol.io) server — from
**Settings > Connectors**. There are two setup pathways, and every connector
uses one of them:

**Zero-setup (the server registers itself).** Most hosted MCP servers support
OAuth dynamic client registration (RFC 7591). For these, nothing is configured
on the Mike server at all: a user clicks **Add**, pastes the server URL (or
picks a preset), and completes the provider's consent screen in a popup. Servers
that use a bearer token or custom headers instead of OAuth also fall in this
pathway — the credentials are entered in the same modal and stored encrypted.

**Bring-your-own OAuth app (you register a client once).** Some providers do
not implement dynamic client registration, so the person hosting Mike creates
an OAuth client with that provider once, puts its credentials in
`backend/.env`, and every user of the deployment can then connect their own
account with one click:

- **Google-hosted MCP servers** (`*.googleapis.com`) — create a Google Cloud
  OAuth client and set `GOOGLE_MCP_OAUTH_CLIENT_ID` / `_SECRET`
  (see `backend/.env.example`).
- **Slack** — see [Slack](#slack) below.

If a user starts an OAuth connect before the deployment is configured, the
error message contains the exact provider-console steps and the redirect URI
to paste — nothing fails silently.

**Redirect URIs.** Every callback below is derived from the backend's
`API_PUBLIC_URL`, which is the browser-reachable frontend gateway *including
its `/api` prefix* (the frontend proxies `/api/*` to the backend, so the
backend's own port never appears in a redirect URI):

| Deployment | `API_PUBLIC_URL` | Register with the provider |
| --- | --- | --- |
| Local development | `http://localhost:3000/api` | `http://localhost:3000/api/user/…/oauth/callback` |
| Production | `https://<your-mike-host>/api` | `https://<your-mike-host>/api/user/…/oauth/callback` |

The path is `/user/mcp-connectors/oauth/callback` for MCP connectors. A
Connect attempt on an unconfigured Slack/Google MCP connector shows the exact
URI, so you can copy it rather than assemble it. A value that does not
byte-match what the provider has on file fails as `redirect_uri_mismatch`.

### Slack

Slack's hosted MCP server (`https://mcp.slack.com/mcp`) gives the assistant
access to the channels and DMs the connecting user can see. The requested
scopes are mostly read/search, plus a few write scopes (`chat:write`,
`reactions:write`, `canvases:write`) — a user approving the consent screen is
granting those too. Slack does not support dynamic client registration, so
the deployment needs a Slack app (created once, by someone with app-creation
rights in the workspace):

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) — the
   fastest path is **From an app manifest**, pasting
   `docs/slack-mcp-app-manifest.example.json` and replacing the redirect URL
   placeholder. The manifest configures the bot user, the agent feature
   (`features.assistant_view`), and the OAuth scopes. (Building by hand
   instead: add the bot user and agent feature yourself.)
2. Two settings the manifest cannot express, required on **either** path:
   turn on the **Slack MCP Server** toggle under the app's *Agents* settings,
   and enable **PKCE** under *OAuth & Permissions*.
3. Add the callback,
   `https://<your-mike-host>/api/user/mcp-connectors/oauth/callback`, as a
   redirect URL. Slack requires HTTPS, so local development needs an HTTPS
   tunnel pointed at the **frontend** (port 3000, which proxies `/api` to the
   backend) — for example `cloudflared tunnel --url http://localhost:3000` —
   with `API_PUBLIC_URL=https://<tunnel-host>/api` in `backend/.env` and the
   matching `https://<tunnel-host>/api/user/mcp-connectors/oauth/callback`
   registered on the Slack app. Quick tunnels get a new hostname on every
   start, so update both when the tunnel restarts.
4. Set `SLACK_MCP_OAUTH_CLIENT_ID` and `SLACK_MCP_OAUTH_CLIENT_SECRET` in
   `backend/.env` and restart the backend.

Each user then clicks **Add** on **Settings > Connectors**, picks the
**Slack** preset, and approves Slack's consent screen. On workspaces with
app approval enabled, a Workspace Owner/Admin must approve the app before
members can authorize it. Tokens are encrypted at rest, and individual tools
can be toggled per connector.

Tools Slack marks as writes — sending messages, adding reactions, creating
canvases and lists, scheduling messages — are cached but kept **disabled**,
and the toggle refuses to enable them: Mike has no human-confirmation step
for write tools yet, so the assistant is only ever given the read and search
tools. The consent screen therefore grants more than the assistant can use;
trim the manifest's user scopes if that is not acceptable for your workspace.

## What this fork adds

- Azure Blob Storage alongside the upstream S3-compatible storage path.
- Microsoft Entra ID alongside Supabase and local authentication.
- Azure OpenAI alongside Anthropic, Gemini, and OpenAI.
- Postgres 16+ migrations that do not require Supabase-managed auth tables.
- A tenant-portable frontend configured at runtime through `GET /config`.
- A single-container production build that serves the exported frontend
  and Express API.
- A local-first Docker stack requiring no Azure subscription.

## Repository layout

- `backend/` — Express API, provider adapters, and schema migrations.
- `frontend/` — statically exported Next.js application.
- `scripts/install/` — optional operator-side Azure and Entra helpers.
- `scripts/local-stack/` — local Postgres, PostgREST, and Azurite support.
- `docs/azure-prereqs.md` — canonical manual Azure installation guide.
- `docs/runbook-local-stack.md` — local development guide.
- `docs/fork-delta.md` — maintained differences from upstream v0.3.0.
- `Dockerfile` — production image bundling frontend and backend.

## Required services

- Postgres 16+.
- Azure Blob Storage, Azurite, or an S3-compatible object store.
- At least one supported LLM provider.
- LibreOffice for DOC/DOCX-to-PDF conversion; it is included in the
  production image.

## Tamper-evident export

Mike hashes a document version's bytes (SHA-256) whenever it writes them.
`GET /api/projects/:projectId/export` returns a manifest of those hashes plus
the accept/reject trail. To check a file you were given, run
`shasum -a 256 lease.docx` and compare it to the manifest. Versions written
before this shipped carry a `null` hash, so they read as unverifiable rather
than as falsely verified.

The manifest also carries a SHA-256 `digest` over its own body (everything
except `digest` and `signature`, serialised with object keys sorted, array
order kept, no whitespace).

Provision a `manifest-signing-key` secret in Key Vault (local dev:
`MANIFEST_SIGNING_KEY`; a 32-byte hex Ed25519 seed, `openssl rand -hex 32`) to
sign that digest. The signature is a raw Ed25519 signature over the bytes
`mike-project-manifest-v1`, a NUL byte, then the digest bytes. Take the public
key from `GET /api/manifest-signing-key`, not from the manifest: whoever edits a
manifest can re-sign it with a key of their own, so the embedded copy shows
consistency, never provenance.

Soft-deleted versions stay in the manifest, carrying their `deleted_at`. A
trail that dropped them would be a weaker attestation, but it does mean the
filename and timestamps of a deleted version are visible to anyone with access
to the project.

## Validation

```bash
(cd backend && pnpm test && pnpm build)
(cd frontend && pnpm test && pnpm lint && pnpm build)
docker build -t mike-azure:local .
```

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting. Never commit
real `.env` files, tenant identifiers, deployment hostnames, or credentials.
Only placeholder-bearing `*.example` environment templates belong in Git.

## License and attribution

AGPL-3.0-only. See [LICENSE](LICENSE).

The application is derived from
[`willchen96/mike`](https://github.com/willchen96/mike). The Azure adaptation
is maintained by Altien.

## Microsoft Word add-in (Beta)

The Mike Word add-in brings Mike into a Word task pane for document chat, quick actions, workflows, supporting files, and tracked edits. See [the Word add-in guide](word-addin/README.md) for setup and Entra sign-in.
