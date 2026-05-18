#requires -Version 7.0
# Marketplace certification-policy lint that complements ARM-TTK with checks
# Partner Center cares about but TTK doesn't enforce:
#
#   1. mainTemplate.json `$schema` is the 2019-04-01 deployment-template URI.
#      Partner Center's uploader validates against that exact schema version
#      and rejects v2 / non-standard URIs with a generic schema error - we
#      already convert v2->v1 via scripts/arm-v2-to-v1.py, this re-asserts
#      the result.
#   2. Broader secret-leak heuristic on outputs - flags any output whose
#      NAME matches password|secret|key|token|connectionString|sasToken|
#      credential. TTK's "Outputs Must Not Contain Secrets" rule only fires
#      when the value is a securestring parameter; this catches the case
#      where someone leaks via `reference()`/`listKeys()` of a runtime
#      resource property under a suggestive name.
#   3. Nested deployments that pass parameters must use
#      `expressionEvaluationOptions.scope: "inner"`. Bicep modules default
#      to inner, but raw `Microsoft.Resources/deployments` resources don't,
#      and outer scope risks leaking outer-scope @secure() values into
#      nested templates that wouldn't otherwise see them.
#   4. viewDefinition.json `Associations.resourceTypes` only lists resource
#      types that mainTemplate actually emits. Stale entries leave broken
#      "deployed resources" tabs in the customer's portal.
#
# Pure read; no network. Run after package-marketplace.ps1's bicep build +
# v2->v1 conversion so it sees the legacy-form template.
#
# Usage:
#   scripts/preflight/cert-policy.ps1
#   scripts/preflight/cert-policy.ps1 -MarketplaceDir other-marketplace

param(
  [string]$MarketplaceDir = ""
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $true
}

if (-not $MarketplaceDir) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  $MarketplaceDir = Join-Path $RepoRoot "marketplace"
}
$MarketplaceDir = (Resolve-Path $MarketplaceDir).Path
$MainTemplate   = Join-Path $MarketplaceDir "mainTemplate.json"
$ViewDefinition = Join-Path $MarketplaceDir "viewDefinition.json"

foreach ($f in $MainTemplate, $ViewDefinition) {
  if (-not (Test-Path $f)) {
    Write-Error "Required file missing: $f"
    exit 1
  }
}

Write-Host "Cert-policy lint against $MarketplaceDir" -ForegroundColor Cyan

$tpl  = Get-Content -Raw -Path $MainTemplate   | ConvertFrom-Json -Depth 100
$view = Get-Content -Raw -Path $ViewDefinition | ConvertFrom-Json -Depth 100

$schemaErrors    = @()
$secretErrors    = @()
$scopeErrors     = @()
$viewErrors      = @()

# ── 1. Schema URI ────────────────────────────────────────────────────────────
$ExpectedSchema = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
if ($tpl.'$schema' -ne $ExpectedSchema) {
  $schemaErrors += "mainTemplate `$schema is '$($tpl.'$schema')'; Partner Center requires '$ExpectedSchema'"
}

# ── 2. Broader secret-leak heuristic on outputs ──────────────────────────────
$SecretNameRe = [regex]"(?i)password|secret|key|token|connectionstring|sastoken|credential"
if ($tpl.outputs) {
  foreach ($prop in $tpl.outputs.PSObject.Properties) {
    if ($SecretNameRe.IsMatch($prop.Name)) {
      # Exempt the small number of known-safe references (KV name/URI, name
      # only, not the secret value). Adjust here if a new safe pattern emerges.
      if ($prop.Name -in @('keyVaultName', 'keyVaultUri', 'keyVaultId')) { continue }
      $secretErrors += "outputs.$($prop.Name): name matches the secret heuristic - rename if non-secret, or remove if it leaks one"
    }
  }
}

# ── 3. Nested deployment scope ───────────────────────────────────────────────
# Bicep modules emit scope:inner; raw deployments default to outer. The pid-*
# tracking deployment shipped by Partner Center has no params and is exempt.
$deployments = @($tpl.resources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' })
foreach ($d in $deployments) {
  $name = $d.name
  if ($name -like '*pid-*') { continue }   # Partner Center tracking GUID
  $params = @($d.properties.parameters.PSObject.Properties)
  if ($params.Count -eq 0) { continue }
  $scope = $d.properties.expressionEvaluationOptions.scope
  if ($scope -ne 'inner') {
    $scopeErrors += "resource '$name': nested deployment with $($params.Count) param(s) but expressionEvaluationOptions.scope is '$(if ($scope) { $scope } else { '<unset, defaults to outer>' })' - must be 'inner'"
  }
}

# ── 4. viewDefinition resource-type alignment ────────────────────────────────
# Each resourceTypes entry in the Associations view should match at least one
# resource emitted by mainTemplate. Nested-deployment children inside module
# templates count - walk recursively.
function Get-AllTypes {
  param($node)
  $types = @()
  if ($node -is [System.Collections.IList]) {
    foreach ($r in $node) { $types += Get-AllTypes $r }
    return $types
  }
  if ($node -is [psobject] -and $node.type) {
    $types += $node.type
  }
  if ($node -is [psobject] -and $node.properties -and $node.properties.template -and $node.properties.template.resources) {
    $types += Get-AllTypes $node.properties.template.resources
  }
  return $types
}
$allTypes = (Get-AllTypes $tpl.resources) | Select-Object -Unique
$assocView = $view.views | Where-Object { $_.kind -eq 'Associations' }
foreach ($v in @($assocView)) {
  foreach ($rt in @($v.properties.resourceTypes)) {
    if ($allTypes -notcontains $rt) {
      $viewErrors += "viewDefinition Associations.resourceTypes: '$rt' is listed but no such resource is emitted by mainTemplate"
    }
  }
}

# ── Report ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==== Cert-policy results ====" -ForegroundColor Cyan
$ok = $true
foreach ($pair in @(
  @{ Label = "Schema URI         "; Errs = $schemaErrors }
  @{ Label = "Output names       "; Errs = $secretErrors }
  @{ Label = "Nested-deploy scope"; Errs = $scopeErrors }
  @{ Label = "viewDefinition     "; Errs = $viewErrors }
)) {
  if ($pair.Errs.Count -gt 0) {
    $ok = $false
    Write-Host ("  " + $pair.Label + ": " + $pair.Errs.Count + " error(s)") -ForegroundColor Red
    foreach ($e in $pair.Errs) { Write-Host "    - $e" }
  } else {
    Write-Host ("  " + $pair.Label + ": OK") -ForegroundColor Green
  }
}
if (-not $ok) { exit 1 }
exit 0
