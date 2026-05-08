# Issue 020 — Azure Blob Storage First, R2 Fallback Isolated

## Goal

Make Azure Blob Storage/Azurite the primary storage path for backend document operations while keeping any R2/AWS fallback isolated behind the existing storage provider boundary until it is safe to remove.

## Context

Local development should use Azurite. Azure deployment should use Azure Blob Storage through managed identity or explicit local connection strings. R2/AWS exists from the upstream app and should not be removed until the Azure path is fully validated.

## What to build

### Storage provider boundary

- Ensure all backend document storage operations go through one storage module/provider.
- Make provider selection explicit through environment variables.
- Prefer Azure Blob when Azure Blob configuration is present.
- Use Azurite via `AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true` locally.
- Keep R2 fallback only in the provider module, not scattered through routes.

### Local validation

- Ensure `documents` container creation is documented or automated for local setup.
- Validate upload, read/display, download, versioning, and delete flows against Azurite.

### Azure validation

- Validate the same flows against Azure Blob in dev.
- Confirm no AWS/R2 env vars are needed for Azure mode.

## Acceptance criteria

- [ ] Backend document routes work with Azurite locally.
- [ ] Backend document routes work with Azure Blob in dev.
- [ ] R2/AWS logic is isolated to the storage provider implementation.
- [ ] No route imports AWS SDK directly.
- [ ] Local runbook explains required Azurite setup.
- [ ] `npm run build` passes in `backend/`.

## Out of scope

- Removing all AWS/R2 code before Azure Blob is validated.
- Frontend storage refactor, except where required to call backend routes.
- Persistence changes unrelated to binary/document storage.

## Dependencies

- `005-storage-provisioning-and-blob-adapter.md`
- `019-frontend-hosted-dependency-isolation.md`

