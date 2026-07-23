# Installation helpers

These PowerShell 7 scripts support the manual Azure installation documented
in [`docs/azure-prereqs.md`](../../docs/azure-prereqs.md). They are optional:
operators can perform the same actions directly with Azure CLI and Microsoft
Graph.

The backend also serves eligible helpers through
`GET /install/scripts/:name`, allowing the `/install` configurator to offer
the appropriate download beside each setup step.

## Requirements

- PowerShell 7 (`pwsh`)
- Azure CLI (`az`)
- An interactive `az login` for the target tenant and subscription
- The directory permissions described by each script

## Scripts

- `create-entra-apps.ps1` — create and configure the API and web app
  registrations.
- `register-redirect-uris.ps1` — update both application and installer
  callback URLs after a hostname change.
- `grant-uami-app-reg-ownership.ps1` — grant a managed identity ownership of
  the web app registration.
- `setup-aoai.ps1` — connect or provision Azure OpenAI.
- `reset-install.ps1` — clear installer state for recovery.
- `revoke-installer-access.ps1` — remove temporary installer access.

Review a script before running it. Values are read from parameters, the
operator's Azure session, and the named Key Vault; no tenant IDs,
credentials, hostnames, or subscription IDs are embedded in these files.
