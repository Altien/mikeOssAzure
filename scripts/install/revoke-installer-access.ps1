#!/usr/bin/env pwsh
# version: 1
<#
.SYNOPSIS
  Remove the operator's "Key Vault Secrets Officer" role on the install
  Key Vault — installation is complete and the operator no longer needs
  to write secrets directly.

.DESCRIPTION
  Bicep grants the deployer Key Vault Secrets Officer at install time so
  /install can hand-off to the operator's az login for things the MI
  can't do (creating Entra apps, provisioning AOAI). After install,
  routine config changes go through /install (which uses the Container
  App's MI). This script revokes the operator's grant so the operator's
  identity has only the role assignments they had before deploying Mike.

  Idempotent: if the assignment is already gone, the script reports it
  and exits 0.

.PARAMETER KeyVaultName
  Name of the KV the operator is currently assigned on.

.PARAMETER PrincipalId
  Optional. Defaults to the signed-in user's object id from `az ad
  signed-in-user show`. Pass explicitly when revoking a different
  identity (e.g. a CI service principal that bootstrapped the deploy).

.EXAMPLE
  ./revoke-installer-access.ps1 -KeyVaultName kv-mike-example
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$KeyVaultName,
    [string]$PrincipalId
)

$ErrorActionPreference = "Stop"

if (-not $PrincipalId) {
    $PrincipalId = az ad signed-in-user show --query id -o tsv
    if (-not $PrincipalId) {
        throw "Cannot determine signed-in user. Pass -PrincipalId explicitly."
    }
}

$kvId = az keyvault show --name $KeyVaultName --query id -o tsv
if (-not $kvId) { throw "Key Vault $KeyVaultName not found." }

Write-Host ""
Write-Host "=== revoke-installer-access.ps1 ===" -ForegroundColor Cyan
Write-Host "Principal:   $PrincipalId"
Write-Host "KV scope:    $kvId"
Write-Host ""

$existing = az role assignment list `
    --assignee-object-id $PrincipalId `
    --scope $kvId `
    --query "[?roleDefinitionName=='Key Vault Secrets Officer']" `
    -o json | ConvertFrom-Json

if (-not $existing -or $existing.Count -eq 0) {
    Write-Host "No 'Key Vault Secrets Officer' assignment to remove." -ForegroundColor DarkGray
    Write-Host "=== Done ===" -ForegroundColor Green
    return
}

az role assignment delete `
    --assignee $PrincipalId `
    --role "Key Vault Secrets Officer" `
    --scope $kvId `
    --output none

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "From now on, KV writes go through /install (the Container App's"
Write-Host "Managed Identity). Manual 'az keyvault secret set' won't work"
Write-Host "from this account anymore."
