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
