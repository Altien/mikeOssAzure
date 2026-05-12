# Push the Mike images to the public publisher ACR for a marketplace release.
#
# Builds the backend container in the registry (server-side, no Docker
# required) and mirrors the pinned PostgREST tag from Docker Hub. Run this
# before scripts/package-marketplace.ps1 so the image tags referenced by
# createUiDefinition.json actually exist when a customer deploys.
#
# Usage:
#   scripts/release-images.ps1 -Version v1.2.0
#   scripts/release-images.ps1 -Version v1.2.0 -Registry acrmikeoss
#   scripts/release-images.ps1 -Version v1.2.0 -PostgrestVersion v12.2.3
#   scripts/release-images.ps1 -Version v1.2.0 -SkipPostgrest    # already mirrored

param(
  [Parameter(Mandatory=$true)] [string]$Version,
  [string]$Registry         = "acrmikeoss",
  [string]$PostgrestVersion = "v12.2.3",
  [switch]$SkipBackend,
  [switch]$SkipPostgrest
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $true
}

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = (Resolve-Path (Join-Path $ScriptDir "..")).Path
# The Dockerfile lives at the repo root and COPYs from both backend/ and
# frontend/ in a multi-stage build, so the build context is the repo root.
$BuildCtx    = $RepoRoot
$Dockerfile  = Join-Path $RepoRoot "Dockerfile"

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  Write-Error "az CLI not found on PATH"
  exit 1
}

Write-Host "Registry         : $Registry"
Write-Host "Backend tag      : backend:$Version"
Write-Host "PostgREST tag    : postgrest:$PostgrestVersion"
Write-Host ""

# ── Backend ──────────────────────────────────────────────────────────────────
if (-not $SkipBackend) {
  if (-not (Test-Path $Dockerfile)) {
    Write-Error "Dockerfile not found at $Dockerfile"
    exit 1
  }
  Write-Host "[1/2] Building backend image in $Registry" -ForegroundColor Cyan
  # The image bundles the static-exported frontend served from the same Express
  # process — see Dockerfile. Build context is the repo root so both backend/
  # and frontend/ are visible to the COPY directives.
  az acr build `
    --registry $Registry `
    --image "backend:$Version" `
    --file $Dockerfile `
    $BuildCtx
  if ($LASTEXITCODE -ne 0) {
    Write-Error "az acr build failed"
    exit 1
  }
} else {
  Write-Host "[1/2] Skipping backend build (-SkipBackend)" -ForegroundColor Yellow
}

# ── PostgREST ────────────────────────────────────────────────────────────────
if (-not $SkipPostgrest) {
  Write-Host "[2/2] Mirroring postgrest:$PostgrestVersion from Docker Hub" -ForegroundColor Cyan
  # --force makes the import idempotent: re-running with the same tag
  # overwrites rather than failing on "image already exists".
  az acr import `
    --name $Registry `
    --source "docker.io/postgrest/postgrest:$PostgrestVersion" `
    --image "postgrest:$PostgrestVersion" `
    --force
  if ($LASTEXITCODE -ne 0) {
    Write-Error "az acr import failed"
    exit 1
  }
} else {
  Write-Host "[2/2] Skipping postgrest mirror (-SkipPostgrest)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Pushed:" -ForegroundColor Green
Write-Host "  ${Registry}.azurecr.io/backend:$Version"
Write-Host "  ${Registry}.azurecr.io/postgrest:$PostgrestVersion"
Write-Host ""
Write-Host "Next: scripts/package-marketplace.ps1 -Version $Version"
