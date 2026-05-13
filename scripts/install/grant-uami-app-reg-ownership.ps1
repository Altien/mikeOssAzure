#!/usr/bin/env pwsh
# version: 1
<#
.SYNOPSIS
  Grant the backend UAMI ownership of the frontend Entra app reg.

.DESCRIPTION
  When the install configurator's slice-9 check reports
  "info: Graph denied" on the redirect-URI row, it means the backend's
  user-assigned managed identity (UAMI) can't read the frontend app
  registration via Microsoft Graph. The fix is to add the UAMI as an
  owner of the app reg — a narrowly-scoped grant that avoids the
  tenant-wide Application.Read.All permission.

  Today this grant is bundled into create-entra-apps.ps1, but operators
  who created the app regs in the portal or via another automation
  (paste-path) never trigger it. This script is the standalone form so
  any operator can fix slice-9 verification regardless of how the app
  regs were created.

  Idempotent: if the UAMI is already an owner, no change.

  See gap #10 in
  docs/issues/azure-migration/036-marketplace-install-gaps.md.

.PARAMETER KeyVaultName
  Name of the Key Vault, e.g. kv-mike-dev. The script reads
  entra-client-id from KV to know which app reg to add ownership on.

.PARAMETER ResourceGroup
  Resource group containing the backend UAMI (named mi-mike-<env>,
  where <env> is the suffix after kv-mike-).

.EXAMPLE
  ./grant-uami-app-reg-ownership.ps1 -KeyVaultName kv-mike-dev -ResourceGroup rg-mike-dev
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$KeyVaultName,
    [Parameter(Mandatory = $true)][string]$ResourceGroup
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== grant-uami-app-reg-ownership.ps1 ===" -ForegroundColor Cyan
Write-Host "Key Vault:        $KeyVaultName"
Write-Host "Resource group:   $ResourceGroup"
Write-Host ""

# Resolve the frontend app reg via its client id stored in KV at install time.
$clientId = az keyvault secret show --vault-name $KeyVaultName --name entra-client-id --query value -o tsv
if (-not $clientId) {
    throw "Could not read entra-client-id from KV '$KeyVaultName'. Run create-entra-apps.ps1 first."
}
Write-Host "Frontend app reg appId: $clientId"

$app = az ad app show --id $clientId -o json | ConvertFrom-Json
if (-not $app) { throw "App with clientId $clientId not found in this tenant." }
$appObjectId = $app.id
Write-Host "Frontend app reg object id: $appObjectId"

# Resolve the UAMI by convention: mi-mike-<env>, where <env> follows the
# kv-mike- prefix of the KV name.
$miName = "mi-mike-$($KeyVaultName -replace '^kv-mike-', '')"
$uamiPrincipalId = az identity show --name $miName --resource-group $ResourceGroup --query principalId -o tsv 2>$null
if (-not $uamiPrincipalId) {
    throw "Could not look up UAMI '$miName' in RG '$ResourceGroup'. Confirm the UAMI exists with: az identity list -g $ResourceGroup -o table"
}
Write-Host "Backend UAMI principal id: $uamiPrincipalId"
Write-Host ""

# Idempotent check — bail early if already an owner.
$existingOwners = @(az ad app owner list --id $clientId --query "[].id" -o tsv 2>$null) `
    -split "`n" `
    | ForEach-Object { $_.Trim() } `
    | Where-Object { $_ }
if ($existingOwners -contains $uamiPrincipalId) {
    Write-Host "UAMI is already an owner — no change needed." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Slice-9 redirect-URI verification should now succeed." -ForegroundColor Green
    return
}

# Add the UAMI as an owner.
Write-Host "Adding UAMI as owner of the frontend app reg..." -ForegroundColor Cyan
$body = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/$uamiPrincipalId" } | ConvertTo-Json -Compress
$tmp = New-TemporaryFile
try {
    Set-Content -Path $tmp -Value $body -Encoding utf8
    az rest --method post `
            --uri "https://graph.microsoft.com/v1.0/applications/$appObjectId/owners/`$ref" `
            --headers "Content-Type=application/json" `
            --body "@$tmp" `
            --output none
    Write-Host "UAMI added as owner." -ForegroundColor Green
} finally {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Refresh /install — the entra-frontend-redirect-uris row should now pass via Graph round-trip instead of returning 'info: Graph denied'."
