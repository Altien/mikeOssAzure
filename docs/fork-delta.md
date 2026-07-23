# Fork delta from upstream Mike v0.3.0

This repository is based on
[`willchen96/mike` v0.3.0](https://github.com/willchen96/mike/releases/tag/v0.3.0).
The upstream application remains recognizable; Azure support is implemented
through provider boundaries and runtime configuration so future upstream
changes can be reviewed and integrated incrementally.

## Authentication

- Adds Microsoft Entra ID and local HS256 authentication alongside Supabase.
- Validates Entra access tokens with JWKS and maps directory groups to roles.
- Moves tenant-specific browser configuration to the backend `GET /config`
  endpoint.
- Keeps sign-in, callback, and logout URL construction on the backend.

## Storage

- Adds an Azure Blob Storage provider behind the existing upload, download,
  delete, and signed-URL boundary.
- Keeps the S3-compatible provider available for upstream-compatible
  deployments.
- Uses Azurite in the local development stack.

## Database

- Runs versioned migrations with `node-pg-migrate` against Postgres 16+.
- Removes assumptions that application users must exist in Supabase-managed
  `auth.users`.
- Preserves PostgREST-shaped access where practical to reduce divergence from
  upstream code.

## Models and integrations

- Adds Azure OpenAI with per-user endpoint, key, deployment, and model
  selection.
- Retains the upstream Anthropic, Gemini, and OpenAI providers.
- Adds optional Microsoft Graph-backed setup and administration flows.

## Runtime and operations

- Builds the Next.js frontend as a static export served by Express.
- Provides a single production Docker image containing the frontend, backend,
  LibreOffice, and migration tooling.
- Adds `/install` for first-time configuration and recovery.
- Adds Application Insights integration when a connection string is supplied.
- Adds a Docker Compose local stack using Postgres, PostgREST, and Azurite.

## Public installation material

- [`azure-prereqs.md`](azure-prereqs.md) is the canonical manual Azure
  installation guide.
- [`../scripts/install/`](../scripts/install/) contains generic PowerShell
  helpers for Entra, redirect-URI, Azure OpenAI, and installer recovery tasks.
- Infrastructure templates and publisher-specific release automation are not
  part of this source release.

## Compatibility rules

- Prefer adapters and runtime switches over replacing shared application
  logic.
- Keep the browser bundle tenant-portable; do not add customer-specific
  `NEXT_PUBLIC_*` variables.
- Keep secrets and deployment identifiers out of tracked files.
- Record intentional schema or behavior differences close to the affected
  code.
- Review each upstream release as a bounded migration rather than merging it
  blindly.
