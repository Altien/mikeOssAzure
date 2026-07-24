# Upgrade an existing Marketplace installation

Each release package produces a matching
`upgrade-marketplace-<version>.ps1` support asset. The customer or their
deployment agent runs one command:

```powershell
Unblock-File ./upgrade-marketplace-1.0.11.ps1
pwsh -File ./upgrade-marketplace-1.0.11.ps1 `
  -ResourceGroup <customer-resource-group> `
  -TargetVersion 1.0.11
```

Prerequisites:

- Azure CLI signed into the subscription containing the Mike installation.
- Contributor (or equivalent) on the Mike resource group.
- PowerShell 7.
- An existing Marketplace backend on version `1.0.9` or `1.0.10`. The script
  stops before changing Azure if it finds any other image or version.

The command:

1. Discovers the existing Container App, environment, Key Vault, and managed identity.
2. Applies a narrow incremental template containing only Log Analytics,
   Application Insights, and `appinsights-connection-string`.
3. Connects Container Apps logs and the backend telemetry environment variable.
4. Updates and runs the migration job. This includes the 1.0.9 schema change
   that permits `courtlistener` in `user_api_keys`.
5. Promotes the backend only after migrations succeed.
6. Verifies backend health and the `Application Insights initialised` boot log.

It never redeploys the complete Marketplace template or rewrites an existing
durable customer secret. If the upgrade fails after changing an image, it
restores both the previous backend image and the previous migration-job image.
The additive, backward-compatible database migrations and telemetry resources
remain in place; a full database rollback would use Azure PostgreSQL
point-in-time restore.

## Initial installer recovery

On a fresh installation, the first tenant-validated Microsoft user who signs
in to `/install` is remembered in Key Vault as
`install-initial-admin-oid` and `install-initial-admin-email`. The immutable
object ID remains a permanent `/install` recovery path if the administrator
later selects the wrong group or Entra does not return the expected group
membership.

An upgrade from an older release cannot infer who performed that historical
first sign-in. Before customer handoff, seed the intended administrator once:

```powershell
$initialAdminOid = az ad user show `
  --id <administrator-email> `
  --query id -o tsv

az keyvault secret set `
  --vault-name <key-vault-name> `
  --name install-initial-admin-oid `
  --value $initialAdminOid

az keyvault secret set `
  --vault-name <key-vault-name> `
  --name install-initial-admin-email `
  --value <administrator-email>
```

## Provider credentials after upgrade

MikeOssAzure uses one organisation-owned credential per external provider.
Anthropic, Gemini, Kimi K3, OpenAI, OpenRouter, CourtListener, and Azure OpenAI
are configured by an administrator through
`https://<backend-fqdn>/install`; users do not paste personal keys in Settings.

After upgrading from 1.0.9 or 1.0.10, open `/install` and confirm every provider
the organisation intends to use is green. In particular, CourtListener requires
the Key Vault secret `courtlistener-api-token`. Kimi K3 is optional and uses
the organisation's Moonshot AI credential in `moonshot-api-key`. If a
credential is missing, the application returns an actionable error directing
an administrator to `/install`.
