#!/usr/bin/env pwsh
# version: 1
<#
.SYNOPSIS
  Create (or update) the two Entra app registrations Mike needs and write
  the resulting IDs and secrets into Key Vault.

.DESCRIPTION
  Single comprehensive script so Entra setup does not need to be split
  across multiple operator runs. Idempotent: if app registrations
  with the configured display names already exist, the script reuses
  them and only patches the bits that drift (claims, redirect URIs,
  required permissions). On every run the script:

    1. Ensures the BACKEND app reg exists (the protected resource).
       Sets identifierUri = api://<id>, exposes the access_as_user scope,
       stamps optional claims (name, email, given_name, family_name,
       groups) on access + id tokens, sets groupMembershipClaims =
       SecurityGroup. Writes entra-backend-client-id and
       entra-backend-scope to KV.
    2. Ensures the FRONTEND app reg exists (the OIDC client).
       Registers web + spa redirect URIs derived from -BackendFqdn,
       declares the required Microsoft Graph delegated permissions
       (User.Read, GroupMember.Read.All, Group.Read.All), stamps the
       same optional claims + groupMembershipClaims. Writes entra-client-id
       and (a fresh) entra-client-secret to KV.
    3. Writes the tenant ID to KV.

  Local redirect URIs (http://localhost:3000/login,
  http://localhost:3000/auth/openid-callback/microsoft) are preserved
  if they already exist on the app — the script merges with the existing
  list rather than replacing.

.PARAMETER KeyVaultName
  Name of the Key Vault, e.g. kv-mike-example. Caller must already have
  Key Vault Secrets Officer on the vault — Bicep grants this on greenfield
  deploy; for redeploys see /install's "Revoke installer access" item.

.PARAMETER BackendFqdn
  Fully-qualified hostname of the backend Container App, e.g.
  my-app.example-hash.uksouth.azurecontainerapps.io. Used to
  derive the redirect URIs.

.PARAMETER DisplayNamePrefix
  App-registration display-name prefix. The two apps end up named
  "<prefix> Backend" and "<prefix> Frontend". Default: "Mike".

.PARAMETER TenantId
  Optional. Defaults to the az CLI's current tenant.

.PARAMETER ResourceGroup
  Optional. When provided, the script looks up the backend Container
  App's user-assigned managed identity (`mi-mike-<env>`) in this RG and
  adds it as an owner of the frontend app registration. Owners can read
  the app reg via Microsoft Graph using their own credentials, which is
  what /install's slice-9 entra-frontend-redirect-uris check needs to
  verify the URIs are wired correctly. Skipping this means the check
  will report "info: Graph denied" until you grant access another way.

.EXAMPLE
  ./create-entra-apps.ps1 -KeyVaultName kv-mike-example -BackendFqdn my-app.example-hash.uksouth.azurecontainerapps.io -ResourceGroup rg-mike-example
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$KeyVaultName,
    [Parameter(Mandatory = $true)][string]$BackendFqdn,
    [string]$DisplayNamePrefix = "Mike",
    [string]$TenantId,
    [string]$ResourceGroup
)

$ErrorActionPreference = "Stop"

# ── Constants ─────────────────────────────────────────────────────────────────

# Microsoft Graph application id (well-known).
$GraphAppId = "00000003-0000-0000-c000-000000000000"

# Well-known delegated-permission IDs on Microsoft Graph. These never change.
$Perm_UserRead          = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"  # User.Read
$Perm_GroupMemberRead   = "bc024368-1153-4739-b217-4326f2e966d0"  # GroupMember.Read.All
$Perm_GroupRead         = "5b567255-7703-4780-807c-7be8301ae99b"  # Group.Read.All

$BackendDisplay  = "$DisplayNamePrefix Backend"
$FrontendDisplay = "$DisplayNamePrefix Frontend"

$WebRedirect         = "https://$BackendFqdn/api/auth/openid-callback/microsoft"
$WebRedirectInstall  = "https://$BackendFqdn/install/auth/microsoft/callback"
$SpaRedirect         = "https://$BackendFqdn/login"

$LocalWebRedirect        = "http://localhost:3000/auth/openid-callback/microsoft"
$LocalWebRedirectInstall = "http://localhost:3001/install/auth/microsoft/callback"
$LocalSpaRedirect        = "http://localhost:3000/login"

# ── Helpers ───────────────────────────────────────────────────────────────────

function Resolve-TenantId {
    if ($TenantId) { return $TenantId }
    $resolved = az account show --query tenantId -o tsv
    if (-not $resolved) { throw "Cannot determine tenant ID. Pass -TenantId or run 'az login'." }
    return $resolved
}

function Find-AppByDisplayName {
    param([string]$DisplayName)
    $found = az ad app list --display-name $DisplayName --query "[0]" -o json | ConvertFrom-Json
    return $found
}

function Ensure-App {
    param([string]$DisplayName)
    $existing = Find-AppByDisplayName -DisplayName $DisplayName
    if ($existing) {
        Write-Host "  Reusing existing app: $DisplayName ($($existing.appId))" -ForegroundColor DarkGray
        return $existing
    }
    Write-Host "  Creating app: $DisplayName" -ForegroundColor Cyan
    $created = az ad app create --display-name $DisplayName -o json | ConvertFrom-Json
    if (-not $created) { throw "Failed to create app: $DisplayName" }
    # Allow Graph propagation a moment so subsequent PATCH calls find it.
    Start-Sleep -Seconds 3
    return $created
}

function Patch-App {
    param(
        [string]$ObjectId,
        [hashtable]$Body
    )
    $json = ($Body | ConvertTo-Json -Depth 10 -Compress)
    # az rest --body wants a path or @-prefixed JSON literal. Write to a temp file.
    $tmp = New-TemporaryFile
    try {
        Set-Content -Path $tmp -Value $json -Encoding utf8
        az rest --method patch `
                --uri "https://graph.microsoft.com/v1.0/applications/$ObjectId" `
                --headers "Content-Type=application/json" `
                --body "@$tmp" `
                --output none
    } finally {
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    }
}

function Optional-Claims-Body {
    $claims = @(
        @{ name = "name"; essential = $false },
        @{ name = "email"; essential = $false },
        @{ name = "given_name"; essential = $false },
        @{ name = "family_name"; essential = $false },
        @{ name = "groups"; essential = $false }
    )
    return @{
        accessToken = $claims
        idToken     = $claims
    }
}

function Merge-RedirectUris {
    param([string[]]$Existing, [string[]]$Desired)
    $set = New-Object System.Collections.Generic.HashSet[string]
    foreach ($u in $Existing) { if ($u) { [void]$set.Add($u) } }
    foreach ($u in $Desired)  { if ($u) { [void]$set.Add($u) } }
    return @($set)
}

function Set-KvSecret {
    param([string]$Name, [string]$Value)
    az keyvault secret set --vault-name $KeyVaultName --name $Name --value $Value --output none
}

# ── Main ──────────────────────────────────────────────────────────────────────

$resolvedTenantId = Resolve-TenantId
Write-Host ""
Write-Host "=== create-entra-apps.ps1 ===" -ForegroundColor Cyan
Write-Host "Tenant:           $resolvedTenantId"
Write-Host "Key Vault:        $KeyVaultName"
Write-Host "Backend FQDN:     $BackendFqdn"
Write-Host "Backend app:      $BackendDisplay"
Write-Host "Frontend app:     $FrontendDisplay"
Write-Host ""

# ── 1. BACKEND app reg (the protected resource / API) ────────────────────────
Write-Host "[1/4] Backend app reg..." -ForegroundColor Cyan
$backendApp = Ensure-App -DisplayName $BackendDisplay

# Existing identifierUri may be missing on first create; api://<appId> is the
# convention every Entra-validated backend uses.
$backendApiId = "api://$($backendApp.appId)"

$scopeId = (az ad app show --id $backendApp.appId --query "api.oauth2PermissionScopes[?value=='access_as_user'].id" -o tsv)
if (-not $scopeId) { $scopeId = [guid]::NewGuid().ToString() }

$backendBody = @{
    identifierUris = @($backendApiId)
    api = @{
        oauth2PermissionScopes = @(
            @{
                id                       = $scopeId
                value                    = "access_as_user"
                type                     = "User"
                isEnabled                = $true
                adminConsentDisplayName  = "Access Mike API as the signed-in user"
                adminConsentDescription  = "Allows the calling app to invoke the Mike backend API on behalf of the signed-in user."
                userConsentDisplayName   = "Access Mike API on your behalf"
                userConsentDescription   = "Allows this application to invoke the Mike backend API on your behalf."
            }
        )
    }
    optionalClaims          = (Optional-Claims-Body)
    groupMembershipClaims   = "SecurityGroup"
}
Patch-App -ObjectId $backendApp.id -Body $backendBody

# ── 2. FRONTEND app reg (OIDC client + SPA) ──────────────────────────────────
Write-Host "[2/4] Frontend app reg..." -ForegroundColor Cyan
$frontendApp = Ensure-App -DisplayName $FrontendDisplay

# Read existing redirect URIs so we don't clobber localhost entries devs added.
$frontendCurrent = az ad app show --id $frontendApp.appId -o json | ConvertFrom-Json
$existingWeb = @($frontendCurrent.web.redirectUris)
$existingSpa = @($frontendCurrent.spa.redirectUris)

$frontendBody = @{
    web = @{
        redirectUris = (Merge-RedirectUris -Existing $existingWeb -Desired @(
            $WebRedirect, $WebRedirectInstall,
            $LocalWebRedirect, $LocalWebRedirectInstall
        ))
    }
    spa = @{
        redirectUris = (Merge-RedirectUris -Existing $existingSpa -Desired @($SpaRedirect, $LocalSpaRedirect))
    }
    optionalClaims        = (Optional-Claims-Body)
    groupMembershipClaims = "SecurityGroup"
    requiredResourceAccess = @(
        @{
            resourceAppId  = $GraphAppId
            resourceAccess = @(
                @{ id = $Perm_UserRead;        type = "Scope" },
                @{ id = $Perm_GroupMemberRead; type = "Scope" },
                @{ id = $Perm_GroupRead;       type = "Scope" }
            )
        }
    )
}
Patch-App -ObjectId $frontendApp.id -Body $frontendBody

# ── 3. Frontend client secret ────────────────────────────────────────────────
Write-Host "[3/4] Frontend client secret..." -ForegroundColor Cyan
# Mint a new secret on every run — the previous one stays valid until its own
# expiry, so this isn't disruptive. Operators who want to rotate just re-run.
$secretJson = az ad app credential reset `
    --id $frontendApp.appId `
    --display-name "install-flow-$(Get-Date -Format 'yyyyMMdd-HHmmss')" `
    --years 1 `
    --query "{password:password}" -o json | ConvertFrom-Json
$frontendSecret = $secretJson.password
if (-not $frontendSecret) { throw "Failed to mint frontend client secret." }

# ── 4. Write everything to Key Vault ─────────────────────────────────────────
Write-Host "[4/5] Writing secrets to KV..." -ForegroundColor Cyan
Set-KvSecret -Name "entra-tenant-id"          -Value $resolvedTenantId
Set-KvSecret -Name "entra-backend-client-id"  -Value $backendApp.appId
Set-KvSecret -Name "entra-backend-scope"      -Value "$backendApiId/access_as_user"
Set-KvSecret -Name "entra-client-id"          -Value $frontendApp.appId
Set-KvSecret -Name "entra-client-secret"      -Value $frontendSecret

# ── 5. Add the backend UAMI as owner of the frontend app reg ────────────────
# This narrowly grants the UAMI Graph read on this app reg only — preferred
# over a tenant-wide Application.Read.All grant. Lets /install verify
# redirect URIs via a real Graph round-trip (slice 9). Skipped when
# -ResourceGroup wasn't supplied: the operator can grant access another way.
if ($ResourceGroup) {
    Write-Host "[5/5] Granting backend UAMI ownership of frontend app reg..." -ForegroundColor Cyan
    $miName = "mi-mike-$($KeyVaultName -replace '^kv-mike-', '')"
    $uamiPrincipalId = az identity show --name $miName --resource-group $ResourceGroup --query principalId -o tsv 2>$null
    if (-not $uamiPrincipalId) {
        Write-Warning "Could not look up UAMI '$miName' in RG '$ResourceGroup'. Skipping owner grant — slice-9 redirect-URI check will report 'Graph denied' until the UAMI gets app-reg read access."
    } else {
        $existingOwners = @(az ad app owner list --id $frontendApp.appId --query "[].id" -o tsv 2>$null) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        if ($existingOwners -contains $uamiPrincipalId) {
            Write-Host "  UAMI is already an owner — no change." -ForegroundColor DarkGray
        } else {
            $body = @{ "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/$uamiPrincipalId" } | ConvertTo-Json -Compress
            $tmp = New-TemporaryFile
            try {
                Set-Content -Path $tmp -Value $body -Encoding utf8
                az rest --method post `
                        --uri "https://graph.microsoft.com/v1.0/applications/$($frontendApp.id)/owners/`$ref" `
                        --headers "Content-Type=application/json" `
                        --body "@$tmp" `
                        --output none
                Write-Host "  UAMI added as owner." -ForegroundColor Green
            } finally {
                Remove-Item -Force $tmp -ErrorAction SilentlyContinue
            }
        }
    }
} else {
    Write-Host "[5/5] Skipping UAMI ownership grant — no -ResourceGroup supplied." -ForegroundColor DarkGray
    Write-Host "       Pass -ResourceGroup to enable /install's slice-9 redirect-URI verification." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Tenant:                $resolvedTenantId"
Write-Host "Backend app id:        $($backendApp.appId)"
Write-Host "Backend scope:         $backendApiId/access_as_user"
Write-Host "Frontend app id:       $($frontendApp.appId)"
Write-Host "Frontend redirect URIs:"
Write-Host "  web (main):    $WebRedirect"
Write-Host "  web (install): $WebRedirectInstall"
Write-Host "  spa (main):    $SpaRedirect"
Write-Host ""
Write-Host "Refresh /install - Entra ID items should now go green." -ForegroundColor Cyan
