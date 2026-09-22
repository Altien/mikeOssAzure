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

### Telemetry

Error reports are sent to the Mike project's own Sentry by default, so the
maintainers can fix failures encountered by forks and self-hosted installs.
Before network transmission, every runtime rebuilds reports from an explicit
allowlist: code locations and line numbers, controlled operation labels,
HTTP method/status and normalized routes, validated correlation IDs, release,
and environment. Client document filenames, document text, raw error and
console messages, request URLs/queries/headers/bodies, user identities, and
breadcrumbs are excluded. Automatic sessions, replay, attachments, traces,
and other non-error payloads are blocked. The same boundary applies to
community and official installations. See the [observability guide](docs/observability.md)
for the exact policy, source-map behavior, and limitations.
To opt out, set `SENTRY_DISABLED=true`
(`NEXT_PUBLIC_SENTRY_DISABLED=true` / `REACT_APP_SENTRY_DISABLED=true` for the
browser and add-in builds); to use your own Sentry instead, set the matching
`*_SENTRY_DSN`.

The built-in DSNs are public submission addresses; stored error reports are
accessible to authorized Sentry organization members. The guide documents
[public-DSN and default-on precedents](docs/observability.md#public-dsns-and-default-on-reporting)
(Zulip Desktop, Element Web, and GitLab's distinct Service Ping mechanism),
and [quota protections and remaining limits](docs/observability.md#quota-protection-and-its-limits).

The [Sentry data audit](docs/sentry-data-audit.md) records the original privacy
findings, their fixes, and the current outbound data inventory. Source-map
uploads are separate and send application source code only when operators
configure upload credentials.

### Manual Azure deployment

For a self-hosted Azure installation, follow
[Deploying Mike to Azure — minimal self-host](docs/azure-prereqs.md).
It is the canonical installation guide and assumes a technical operator
comfortable with Azure CLI, Docker, PowerShell 7, and Entra administration.

Generic helper scripts in [`scripts/install/`](scripts/install/) automate
the error-prone Entra registration, redirect-URI, Azure OpenAI, and recovery
steps. They use the operator's current Azure login and contain no deployment
credentials.

## Documentation

- [Documentation index](docs/README.md)
- [Troubleshooting](docs/troubleshooting.md)
- [MCP connectors](docs/connectors.md)
- [CourtListener integration](docs/courtlistener.md)
- [Microsoft Word add-in](word-addin/README.md)
- [Tamper-evident exports](docs/tamper-evident-exports.md)
- [Safe local testing](docs/safe-local-testing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

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
