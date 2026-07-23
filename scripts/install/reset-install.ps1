#!/usr/bin/env pwsh
# version: 1
<#
.SYNOPSIS
  DESTRUCTIVE: re-arm /install for first-run by re-issuing the bootstrap
  token and (optionally) clearing operator-set secrets.

.DESCRIPTION
  Recovery path for a deployment whose admins have locked themselves out
  (e.g., emptied the admin group, lost the Entra tenant). After running
  this:
    - kv:install-bootstrap-token receives a fresh GUID, printed to
      stdout for the operator to paste back into /install.
    - Optionally (with -WipeConfig) deletes operator-set KV secrets so
      the install flow is fully clean.

  This bypasses the bootstrap-retired auto-flag — it does not undo prior
  Entra sign-in records, but it makes /install accept the bootstrap path
  again. Subscription owner intervention only — caller must already have
  Key Vault Secrets Officer.

.PARAMETER KeyVaultName
  Target KV.

.PARAMETER WipeConfig
  Optional switch. When set, clears these KV secrets (each becomes
  empty, not deleted): entra-client-id, entra-client-secret,
  entra-backend-client-id, entra-backend-scope, entra-tenant-id,
  entra-admin-group-ids, entra-member-group-ids, anthropic-api-key,
  openai-api-key, gemini-api-key, azure-openai-endpoint,
  azure-openai-api-key. Keep audit-relevant secrets like auth-state-secret
  and postgrest-jwt-secret alone.

.EXAMPLE
  ./reset-install.ps1 -KeyVaultName kv-mike-example
  ./reset-install.ps1 -KeyVaultName kv-mike-example -WipeConfig
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$KeyVaultName,
    [switch]$WipeConfig
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== reset-install.ps1 ===" -ForegroundColor Yellow
Write-Host "Key Vault:   $KeyVaultName"
Write-Host "WipeConfig:  $WipeConfig"
Write-Host ""
Write-Warning "This is a destructive recovery operation."
$confirm = Read-Host "Type 'reset' to confirm"
if ($confirm -ne "reset") {
    Write-Host "Aborted." -ForegroundColor Yellow
    return
}

$newToken = [System.Guid]::NewGuid().ToString()

az keyvault secret set --vault-name $KeyVaultName --name install-bootstrap-token --value $newToken --output none

if ($WipeConfig) {
    $toClear = @(
        "entra-client-id",
        "entra-client-secret",
        "entra-backend-client-id",
        "entra-backend-scope",
        "entra-tenant-id",
        "entra-admin-group-ids",
        "entra-member-group-ids",
        "anthropic-api-key",
        "openai-api-key",
        "gemini-api-key",
        "azure-openai-endpoint",
        "azure-openai-api-key"
    )
    foreach ($name in $toClear) {
        try {
            az keyvault secret set --vault-name $KeyVaultName --name $name --value "" --output none
            Write-Host "  cleared $name" -ForegroundColor DarkGray
        } catch {
            # Probably the secret doesn't exist yet — fine.
        }
    }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "New bootstrap token: $newToken"
Write-Host ""
Write-Host "Open /install in a browser, paste this token, and walk the checklist."
Write-Host "Save the token somewhere safe - once you sign in via Microsoft as"
Write-Host "an admin-group member, the token retires automatically."
