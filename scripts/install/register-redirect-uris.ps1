#!/usr/bin/env pwsh
# version: 2
<#
.SYNOPSIS
  Re-register the frontend app's redirect URIs after the backend FQDN
  changes (custom domain, region migration, etc.).

.DESCRIPTION
  create-entra-apps.ps1 stamps redirect URIs at app-creation time. If the
  Container App's FQDN later changes — e.g., the customer adds a custom
  domain or migrates regions — the redirect URIs no longer match and
  Microsoft sign-in breaks. Run this script to add the new URIs to the
  frontend app's web + spa platforms. It does NOT remove old URIs;
  Microsoft tolerates extras and removing URIs while a sign-in is in
  flight is risky.

  Reads the frontend app's GUID from KV (entra-client-id), so the
  caller doesn't have to thread it through.

.PARAMETER KeyVaultName
  KV containing entra-client-id and entra-tenant-id.

.PARAMETER BackendFqdn
  New backend FQDN. Must NOT include scheme — the script prefixes
  https:// and the route paths automatically.

.EXAMPLE
  ./register-redirect-uris.ps1 -KeyVaultName kv-mike-example `
                               -BackendFqdn mike.example.com
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$KeyVaultName,
    [Parameter(Mandatory = $true)][string]$BackendFqdn
)

$ErrorActionPreference = "Stop"

# Two web redirect URIs need to land for sign-in to work end-to-end:
#   /api/auth/openid-callback/microsoft  — main app (post-sign-in for users)
#   /install/auth/microsoft/callback     — operator /install OIDC flow
# Earlier versions of this script only registered the first; sign-ins
# from /install would then return AADSTS50011 after a custom-domain or
# region change. Mirror create-entra-apps.ps1, which registers both.
$WebRedirect        = "https://$BackendFqdn/api/auth/openid-callback/microsoft"
$WebRedirectInstall = "https://$BackendFqdn/install/auth/microsoft/callback"
$SpaRedirect        = "https://$BackendFqdn/login"

Write-Host ""
Write-Host "=== register-redirect-uris.ps1 ===" -ForegroundColor Cyan
Write-Host "Key Vault:        $KeyVaultName"
Write-Host "Web (main):       $WebRedirect"
Write-Host "Web (install):    $WebRedirectInstall"
Write-Host "SPA:              $SpaRedirect"
Write-Host ""

# Find the frontend app via the client-id stored in KV at install time.
$clientId = az keyvault secret show --vault-name $KeyVaultName --name entra-client-id --query value -o tsv
if (-not $clientId) {
    throw "Could not read entra-client-id from KV. Run create-entra-apps.ps1 first."
}

$app = az ad app show --id $clientId -o json | ConvertFrom-Json
if (-not $app) { throw "App with clientId $clientId not found in this tenant." }

$existingWeb = @($app.web.redirectUris)
$existingSpa = @($app.spa.redirectUris)

$desiredWeb = @($existingWeb + $WebRedirect + $WebRedirectInstall | Sort-Object -Unique)
$desiredSpa = @($existingSpa + $SpaRedirect | Sort-Object -Unique)

if (
    ($desiredWeb.Count -eq $existingWeb.Count) -and
    ($desiredSpa.Count -eq $existingSpa.Count)
) {
    Write-Host "Both URIs already present - no change needed." -ForegroundColor DarkGray
    return
}

$body = @{
    web = @{ redirectUris = $desiredWeb }
    spa = @{ redirectUris = $desiredSpa }
} | ConvertTo-Json -Depth 5 -Compress

$tmp = New-TemporaryFile
try {
    Set-Content -Path $tmp -Value $body -Encoding utf8
    az rest --method patch `
            --uri "https://graph.microsoft.com/v1.0/applications/$($app.id)" `
            --headers "Content-Type=application/json" `
            --body "@$tmp" `
            --output none
} finally {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Web platform redirect URIs:"
$desiredWeb | ForEach-Object { Write-Host "  - $_" }
Write-Host "SPA platform redirect URIs:"
$desiredSpa | ForEach-Object { Write-Host "  - $_" }
