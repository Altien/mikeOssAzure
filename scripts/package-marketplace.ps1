# Build the Mike Azure Marketplace deployment package.
#
# Compiles infra/main.bicep into marketplace/mainTemplate.json, validates the
# UI definition and view definition, and zips the three files into a flat
# archive ready to upload to Partner Center.
#
# Partner Center rejects archives with nested folders, so the zip contains
# only the three top-level files — no `marketplace/` prefix.
#
# Usage:
#   scripts/package-marketplace.ps1
#   scripts/package-marketplace.ps1 -Version v1.2.0
#   scripts/package-marketplace.ps1 -OutDir dist
#   scripts/package-marketplace.ps1 -Version v1.2.0 -OutDir dist

param(
  [string]$Version = "",
  [string]$OutDir  = "dist"
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $true
}

# ── Resolve paths relative to repo root ──────────────────────────────────────
$ScriptDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot        = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$MarketplaceDir  = Join-Path $RepoRoot "marketplace"
$BicepSource     = Join-Path $RepoRoot "infra/main.bicep"
$MainTemplate    = Join-Path $MarketplaceDir "mainTemplate.json"
$UiDefinition    = Join-Path $MarketplaceDir "createUiDefinition.json"
$ViewDefinition  = Join-Path $MarketplaceDir "viewDefinition.json"

# ── Pre-flight ───────────────────────────────────────────────────────────────
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  Write-Error "az CLI not found on PATH"
  exit 1
}

foreach ($f in @($BicepSource, $UiDefinition, $ViewDefinition)) {
  if (-not (Test-Path $f)) {
    Write-Error "Missing $f"
    exit 1
  }
}

# Normalize an explicit -Version into ARM's required contentVersion format
# (n.n.n.n). Strips a leading 'v' and pads with zeros: 'v1.2' -> '1.2.0.0',
# '1.2.3' -> '1.2.3.0'. Returns $null if the input isn't numeric-dotted.
function ConvertTo-ArmContentVersion([string]$ver) {
  $stripped = $ver -replace '^v', ''
  if ($stripped -notmatch '^\d+(\.\d+){0,3}$') { return $null }
  $parts = @($stripped -split '\.')
  while ($parts.Count -lt 4) { $parts += '0' }
  return ($parts -join '.')
}

$VersionExplicit = -not [string]::IsNullOrEmpty($Version)
if (-not $VersionExplicit) {
  try {
    $Version = (git -C $RepoRoot rev-parse --short HEAD 2>$null).Trim()
  } catch { }
  if (-not $Version) {
    $Version = (Get-Date -AsUTC -Format "yyyyMMddHHmmss")
  }
}

$ContentVersion = ConvertTo-ArmContentVersion $Version
if ($VersionExplicit -and -not $ContentVersion) {
  Write-Error "Version '$Version' is not a valid ARM contentVersion. Expected n[.n[.n[.n]]] (e.g. 1.2.0 or v1.2.3.4)."
  exit 1
}

$ZipPath = Join-Path (Join-Path $RepoRoot $OutDir) "mike-marketplace-$Version.zip"

Write-Host "Version        : $Version"
if ($ContentVersion) {
  Write-Host "contentVersion : $ContentVersion"
} else {
  Write-Host "contentVersion : (unchanged — $Version is not ARM-compatible; pass -Version n.n.n.n to override)"
}
Write-Host "Output         : $ZipPath"
Write-Host ""

# ── Compile bicep → mainTemplate.json ────────────────────────────────────────
Write-Host "[1/3] Compiling $BicepSource -> mainTemplate.json" -ForegroundColor Cyan
az bicep build --file $BicepSource --outfile $MainTemplate
if ($LASTEXITCODE -ne 0) {
  Write-Error "az bicep build failed"
  exit 1
}

# Stamp contentVersion into the generated template so the Marketplace listing
# tracks the build version rather than bicep's default 1.0.0.0.
if ($ContentVersion) {
  $tpl = Get-Content -Raw -Path $MainTemplate | ConvertFrom-Json -Depth 100
  $tpl.contentVersion = $ContentVersion
  $tpl | ConvertTo-Json -Depth 100 | Set-Content -Path $MainTemplate -Encoding utf8NoBOM
}

# ── Validate JSON files parse ────────────────────────────────────────────────
Write-Host "[2/3] Validating JSON" -ForegroundColor Cyan
foreach ($f in @($MainTemplate, $UiDefinition, $ViewDefinition)) {
  try {
    Get-Content -Raw -Path $f | ConvertFrom-Json -Depth 100 | Out-Null
  } catch {
    Write-Error "Invalid JSON: $f — $($_.Exception.Message)"
    exit 1
  }
}

# ── Package ──────────────────────────────────────────────────────────────────
$AbsOutDir = Split-Path -Parent $ZipPath
New-Item -ItemType Directory -Path $AbsOutDir -Force | Out-Null
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

# Stage viewDefinition.json into a temp dir so we can stamp contentVersion
# into the zip copy without mutating the tracked source file.
# (mainTemplate.json is gitignored, so it's patched in place above.)
$StageDir   = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) "mike-mp-$([Guid]::NewGuid())") -Force
$StagedView = Join-Path $StageDir "viewDefinition.json"
try {
  if ($ContentVersion) {
    $vd = Get-Content -Raw -Path $ViewDefinition | ConvertFrom-Json -Depth 100
    $vd.contentVersion = $ContentVersion
    $vd | ConvertTo-Json -Depth 100 | Set-Content -Path $StagedView -Encoding utf8NoBOM
  } else {
    Copy-Item -Path $ViewDefinition -Destination $StagedView
  }

  Write-Host "[3/3] Building $ZipPath" -ForegroundColor Cyan
  # Compress-Archive flattens entries to leaf names when fed an array of file
  # paths, so the archive contains the three files at the top level — no folder
  # prefix (Partner Center rejects nested archives). The staged viewDefinition
  # has the same leaf name, so the archive entry name is correct.
  Compress-Archive `
    -Path @($MainTemplate, $UiDefinition, $StagedView) `
    -DestinationPath $ZipPath `
    -CompressionLevel Optimal
} finally {
  Remove-Item -Recurse -Force $StageDir -ErrorAction SilentlyContinue
}

# Print archive contents
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  foreach ($entry in $zip.Entries) {
    "  {0,10}  {1}" -f $entry.Length, $entry.FullName | Write-Host
  }
} finally {
  $zip.Dispose()
}

Write-Host ""
Write-Host "Built $ZipPath" -ForegroundColor Green
