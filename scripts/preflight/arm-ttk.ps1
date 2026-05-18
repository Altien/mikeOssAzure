#requires -Version 7.0
# Run Azure/arm-ttk against the marketplace/ folder and fail non-zero on any
# best-practice rule violation. Catches the class of issue Partner Center
# would otherwise reject on at submission time (see commit d9786a0 — the
# 1.0.2 rejection that motivated this gate).
#
# On first run, clones Azure/arm-ttk into $env:LOCALAPPDATA\arm-ttk so we
# don't depend on the user pre-installing the PowerShell module. Subsequent
# runs reuse the cached clone.
#
# Usage:
#   scripts/preflight/arm-ttk.ps1
#   scripts/preflight/arm-ttk.ps1 -MarketplaceDir other-marketplace
#   scripts/preflight/arm-ttk.ps1 -UpdateModule    # git pull the cached clone

param(
  [string]$MarketplaceDir = "",
  [switch]$UpdateModule
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $true
}

# ── Resolve the marketplace folder relative to the repo root ─────────────────
if (-not $MarketplaceDir) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  $MarketplaceDir = Join-Path $RepoRoot "marketplace"
}
if (-not (Test-Path $MarketplaceDir)) {
  Write-Error "Marketplace folder not found: $MarketplaceDir"
  exit 1
}
$MarketplaceDir = (Resolve-Path $MarketplaceDir).Path

# mainTemplate.json is gitignored - bail with a friendly hint if a caller runs
# this before the bicep build has produced one. package-marketplace.ps1 calls
# this script after `az bicep build`, so this only fires for direct invocations.
if (-not (Test-Path (Join-Path $MarketplaceDir "mainTemplate.json"))) {
  Write-Error "mainTemplate.json missing in $MarketplaceDir. Run `az bicep build --file infra/main.bicep --outfile $MarketplaceDir/mainTemplate.json` (or scripts/package-marketplace.ps1) first."
  exit 1
}

# ── Bootstrap arm-ttk if not already cached ──────────────────────────────────
# The PowerShell module form (Install-Module arm-ttk) is published only
# sporadically and lags master. Cloning the repo directly tracks the latest
# rule set Microsoft is shipping.
$CacheRoot  = Join-Path $env:LOCALAPPDATA "arm-ttk"
$ModulePath = Join-Path $CacheRoot "arm-ttk\arm-ttk.psd1"

if (-not (Test-Path $ModulePath)) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "arm-ttk module not found at $ModulePath and git is unavailable to clone it from https://github.com/Azure/arm-ttk"
    exit 1
  }
  Write-Host "Cloning Azure/arm-ttk to $CacheRoot (one-time setup)..." -ForegroundColor Cyan
  git clone --depth 1 https://github.com/Azure/arm-ttk.git $CacheRoot
  if (-not (Test-Path $ModulePath)) {
    Write-Error "Clone completed but module manifest still missing at $ModulePath"
    exit 1
  }
} elseif ($UpdateModule) {
  Write-Host "Updating cached arm-ttk clone at $CacheRoot..." -ForegroundColor Cyan
  git -C $CacheRoot pull --ff-only
}

# Force-import in case a stale version is already in the session.
Import-Module $ModulePath -Force

# ── Run ──────────────────────────────────────────────────────────────────────
Write-Host "Running ARM-TTK against $MarketplaceDir" -ForegroundColor Cyan
$results = Test-AzTemplate -TemplatePath $MarketplaceDir
$passed = @($results | Where-Object { $_.Passed })
$failed = @($results | Where-Object { -not $_.Passed })

Write-Host ""
Write-Host "==== ARM-TTK results ====" -ForegroundColor Cyan
Write-Host ("  Passed: " + $passed.Count) -ForegroundColor Green
if ($failed.Count -eq 0) {
  Write-Host "  Failed: 0" -ForegroundColor Green
  exit 0
}

Write-Host ("  Failed: " + $failed.Count) -ForegroundColor Red
foreach ($f in $failed) {
  Write-Host ""
  Write-Host ("[" + $f.Name + "] " + $f.File.Name) -ForegroundColor Yellow
  foreach ($e in $f.Errors) {
    $loc = if ($e.TargetObject -and $e.TargetObject.JSONPath) {
      $e.TargetObject.JSONPath
    } elseif ($e.TargetObject -and $e.TargetObject.apiVersion) {
      "apiVersion=" + $e.TargetObject.apiVersion + ", type=" + $e.TargetObject.type
    } else {
      "<no-target>"
    }
    $msg = if ($e.Message) { $e.Message } else { $e.Exception.Message }
    Write-Host ("  - " + $msg + "  [" + $loc + "]")
  }
}
exit 1
