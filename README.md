# Mike for Azure

AGPL-3.0 fork of the upstream Mike repository, adapted to run end-to-end
on Microsoft Azure (or locally without any hosted dependency). Published
in fulfilment of AGPL §13 obligations for network-deployed copies of
this code operated by Altien.

## What this fork adds

- **Azure Blob Storage** as a storage provider alongside the upstream
  Cloudflare R2 / S3 path.
- **Microsoft Entra ID** as an auth provider alongside the upstream
  Supabase Auth, with full JWKS validation, group-to-role mapping, and
  a backend-owned OpenID code-flow login.
- **Azure OpenAI** as an LLM provider alongside Anthropic and Gemini,
  with per-user endpoint/key/deployment and an in-app deployment
  picker.
- **Local-first development stack** (`docker-compose.dev.yml`) so the
  full app runs on a developer machine without any hosted dependency.
- **Schema migrations** via `node-pg-migrate` against any Postgres 16+
  server, replacing the upstream Supabase-extension dependencies (RLS
  policies, `auth.users` FK, `handle_new_user` trigger).
- **`/install` configurator** — server-rendered config admin UI that
  reads/writes Key Vault via the Container App's Managed Identity.
- **Tenant-portable frontend bundle** — runtime `/config` endpoint
  replaces build-time `NEXT_PUBLIC_*` env baking, so the same Docker
  image ships to any tenant.

## Repository layout

- `backend/` — Express API + provider adapters + schema migrations.
- `frontend/` — Next.js application built as a static export.
- `scripts/local-stack/` — Postgres + PostgREST + Azurite bootstrap.
- `scripts/dev-infra-check.ps1` — local stack smoke check.
- `Dockerfile` — multistage build that bundles the frontend export
  into the backend image so a single container serves both.
- `docs/` — runbooks and design notes (see below).

## Local development

See [`docs/runbook-local-stack.md`](docs/runbook-local-stack.md). The
stack runs against Docker Postgres + PostgREST + Azurite with HS256
local auth, no hosted dependencies. For local Entra dev see
[`docs/runbook-entra-local-auth.md`](docs/runbook-entra-local-auth.md).

```bash
docker compose -f docker-compose.dev.yml up -d
npm install --prefix backend && npm install --prefix frontend
npm run migrate:dev --prefix backend
npm run dev --prefix backend     # :3001
npm run dev --prefix frontend    # :3000
```

## Running on Azure

See [`docs/azure-prereqs.md`](docs/azure-prereqs.md) for the list of
Azure resources you need to provision before deploying this code. This
fork **does not ship Bicep templates or one-click deployment** —
provisioning is the operator's responsibility. Altien offers a managed
Marketplace deployment that handles provisioning end to end.

## Required services (any deployment)

- Postgres 16+ (Azure Database for PostgreSQL Flexible Server, or any
  hosted Postgres in supabase mode).
- Object storage: Azure Blob (production) or Cloudflare R2 / any S3.
- LibreOffice in the runtime image for DOC/DOCX → PDF conversion (the
  bundled Dockerfile installs it).
- At least one LLM provider key (Anthropic / Gemini / OpenAI / Azure
  OpenAI). Per-user keys can be set via the in-app Account → Models
  page; shared keys go in env / Key Vault.

## Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```

## License

AGPL-3.0-only. See `LICENSE`.

## Acknowledgements

This repository is an AGPL-3.0 fork of the upstream Mike repository at
[`willchen96/mike`](https://github.com/willchen96/mike) (`main`
branch). All architectural credit for the application itself belongs
upstream; this fork is purely the Azure adaptation and developer-
experience additions.

### Upstream baseline

This fork branches from upstream commit
[`b780a4b`](https://github.com/willchen96/mike/commit/b780a4b).
Every file diverged from that baseline is listed in
[`docs/fork-delta.md`](docs/fork-delta.md).

### Merged from upstream

Upstream commits and pull requests merged into this fork after the
initial baseline. Each entry links directly to the upstream source —
or, where the integration was non-trivial, to an internal note that
in turn contains the direct upstream links.

_None yet._

When the first upstream merge lands, add an entry of the form:

> - Upstream PR [`#NNN`](https://github.com/willchen96/mike/pull/NNN) — short description.
>   Landed in this fork as
>   [`<our-sha>`](https://github.com/Altien/mikeOssAzure/commit/&lt;our-sha&gt;).
>   For ripped-out / re-shaped extractions where naming individual
>   source commits is impractical, link a
>   `docs/extractions/<name>.md` note that lists the upstream URLs.

### Merged from other branches or forks

When functionality is pulled in from one of our other branches or any
third-party fork, an entry goes here with a direct GitHub link to the
source commit / PR (or to a `docs/extractions/<name>.md` note for
multi-commit extractions).

_None yet._
