# Installation helpers

This directory is a mount point for operator PowerShell scripts supporting
the manual Azure installation documented in
[`docs/azure-prereqs.md`](../../docs/azure-prereqs.md). **It ships empty.**

The backend serves any script placed here through
`GET /install/scripts/:name`, so the `/install` configurator can offer a
download beside the relevant setup step. Only filenames matching
`^[a-z][a-z0-9-]+\.ps1$` are served, and nothing outside this directory is
reachable through that route.

When the directory holds no scripts — the default — the route returns 404
with an explanatory message and the configurator's download buttons degrade
cleanly. Nothing breaks; the buttons simply have nothing to offer.

## Supplying your own

Drop `.ps1` files here at image build time; the `Dockerfile` copies them
into the image and they are served as-is. Typical helpers cover creating the
Entra app registrations, updating redirect URIs after a hostname change,
granting a managed identity ownership of an app registration, connecting
Azure OpenAI, clearing installer state for recovery, and removing temporary
installer access — all actions an operator can equally perform directly with
Azure CLI and Microsoft Graph.

## Requirements for scripts placed here

- PowerShell 7 (`pwsh`)
- Azure CLI (`az`)
- An interactive `az login` for the target tenant and subscription

Keep tenant IDs, credentials, hostnames and subscription IDs out of the
files themselves — take them as parameters, or read them from the operator's
Azure session and the named Key Vault at run time.
