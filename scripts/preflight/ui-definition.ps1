#requires -Version 7.0
# Validate createUiDefinition.json against:
#   1. Structural lint - required top-level keys, well-formed
#      basics/steps/outputs blocks, unique control names within each
#      scope. Catches the obvious structural mistakes that would render
#      the UI broken at customer-deploy time.
#   2. Cross-reference lint - every `outputs.*` expression that reads
#      `basics(...)` or `steps(...).element` resolves to a control that
#      actually exists. Catches the silent-empty-string class of bug
#      where renaming a control without updating the output map sends
#      "" to the ARM parameter.
#
# JSON-schema validation against the published CreateUIDef schema was
# considered, but PowerShell's Test-Json cannot parse Microsoft's schema
# (uses a $schema URI Test-Json rejects, and the schema itself is shallow
# enough that structural lint covers the same ground).
#
# Usage:
#   scripts/preflight/ui-definition.ps1
#   scripts/preflight/ui-definition.ps1 -UiDefinitionPath path/to/createUiDefinition.json

param(
  [string]$UiDefinitionPath = ""
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $true
}

# ── Resolve path ─────────────────────────────────────────────────────────────
if (-not $UiDefinitionPath) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  $UiDefinitionPath = Join-Path $RepoRoot "marketplace\createUiDefinition.json"
}
if (-not (Test-Path $UiDefinitionPath)) {
  Write-Error "createUiDefinition.json not found: $UiDefinitionPath"
  exit 1
}
$UiDefinitionPath = (Resolve-Path $UiDefinitionPath).Path

Write-Host "Validating $UiDefinitionPath" -ForegroundColor Cyan

$raw = Get-Content -Raw -Path $UiDefinitionPath
try {
  $ui = $raw | ConvertFrom-Json -Depth 100
} catch {
  Write-Error "createUiDefinition.json is not valid JSON: $($_.Exception.Message)"
  exit 1
}

# ── 1. Structural lint ───────────────────────────────────────────────────────
# Required top-level keys per the CreateUIDef spec. The handler enum lets
# Microsoft.Compute.MultiVm (legacy) and Microsoft.Azure.CreateUIDef (current,
# what we ship).
$structuralErrors = @()
foreach ($key in '$schema', 'handler', 'version', 'parameters') {
  if (-not $ui.PSObject.Properties.Name.Contains($key)) {
    $structuralErrors += "top-level key '$key' is missing"
  }
}
if ($ui.handler -and $ui.handler -notin @('Microsoft.Compute.MultiVm', 'Microsoft.Azure.CreateUIDef')) {
  $structuralErrors += "handler '$($ui.handler)' is not a recognised value"
}
if ($ui.parameters) {
  if ($null -eq $ui.parameters.basics)  { $structuralErrors += "parameters.basics is missing (must be an array, even if empty)" }
  elseif ($ui.parameters.basics -isnot [System.Collections.IList]) { $structuralErrors += "parameters.basics must be an array" }
  if ($null -eq $ui.parameters.steps)   { $structuralErrors += "parameters.steps is missing" }
  elseif ($ui.parameters.steps -isnot [System.Collections.IList])  { $structuralErrors += "parameters.steps must be an array" }
  if ($null -eq $ui.parameters.outputs) { $structuralErrors += "parameters.outputs is missing - mainTemplate parameters will receive no values" }
  elseif (-not @($ui.parameters.outputs.PSObject.Properties).Count) {
    $structuralErrors += "parameters.outputs is empty - mainTemplate parameters will receive no values"
  }
}
# Each control needs a name + type so outputs can reference it.
foreach ($b in @($ui.parameters.basics)) {
  if (-not $b.name) { $structuralErrors += "basics[]: a control is missing 'name'" }
  if (-not $b.type) { $structuralErrors += "basics[$($b.name)]: missing 'type'" }
}
foreach ($s in @($ui.parameters.steps)) {
  if (-not $s.name)  { $structuralErrors += "steps[]: a step is missing 'name'"; continue }
  if (-not $s.label) { $structuralErrors += "steps[$($s.name)]: missing 'label' (shown in the wizard sidebar)" }
  if ($null -eq $s.elements) { $structuralErrors += "steps[$($s.name)]: missing 'elements' array"; continue }
  foreach ($e in @($s.elements)) {
    if (-not $e.name) { $structuralErrors += "steps[$($s.name)].elements[]: a control is missing 'name'" }
    if (-not $e.type) { $structuralErrors += "steps[$($s.name)].elements[$($e.name)]: missing 'type'" }
  }
}
# Name uniqueness within scope - duplicates cause the wizard to fail loading
# with a generic error that's hard to track down post-hoc.
$basicsNames = @($ui.parameters.basics | ForEach-Object { $_.name } | Where-Object { $_ })
$dupBasics   = $basicsNames | Group-Object | Where-Object Count -gt 1
foreach ($g in $dupBasics) { $structuralErrors += "basics: duplicate control name '$($g.Name)' ($($g.Count) occurrences)" }

$stepNames = @($ui.parameters.steps | ForEach-Object { $_.name } | Where-Object { $_ })
$dupSteps  = $stepNames | Group-Object | Where-Object Count -gt 1
foreach ($g in $dupSteps) { $structuralErrors += "steps: duplicate step name '$($g.Name)' ($($g.Count) occurrences)" }
foreach ($s in @($ui.parameters.steps)) {
  $elNames = @($s.elements | ForEach-Object { $_.name } | Where-Object { $_ })
  $dupEls  = $elNames | Group-Object | Where-Object Count -gt 1
  foreach ($g in $dupEls) { $structuralErrors += "steps[$($s.name)].elements: duplicate name '$($g.Name)' ($($g.Count) occurrences)" }
}

# ── 2. Cross-reference lint ──────────────────────────────────────────────────
# Collect every defined control name keyed by its containing step ('basics' or
# the step's own name). Then walk outputs.* and resolve each basics(...) /
# steps(...).element reference.

$controls = @{ basics = @{} }
foreach ($b in @($ui.parameters.basics)) {
  if (-not $b.name) { continue }
  $controls.basics[$b.name] = $b.type
}
foreach ($s in @($ui.parameters.steps)) {
  $stepName = $s.name
  if (-not $stepName) { continue }
  $controls[$stepName] = @{}
  foreach ($e in @($s.elements)) {
    if (-not $e.name) { continue }
    $controls[$stepName][$e.name] = $e.type
  }
}

# Regex patterns for the two reference forms ARM CreateUIDef expressions use.
# basics('name')             - reads a basics-block control
# steps('step').element      - reads an element inside a step (the .element
#                              suffix is optional for whole-step refs but in
#                              practice always present in outputs)
$basicsRefRe = [regex]"basics\(\s*'([^']+)'\s*\)"
$stepsRefRe  = [regex]"steps\(\s*'([^']+)'\s*\)\.(\w+)"

$lintErrors = @()
$outputsObj = $ui.parameters.outputs
if ($null -eq $outputsObj) {
  $lintErrors += "outputs block is missing - mainTemplate parameters will receive no values"
} else {
  foreach ($prop in $outputsObj.PSObject.Properties) {
    $value = $prop.Value
    if ($value -isnot [string]) { continue }   # literal numbers/bools/objects: nothing to resolve
    foreach ($m in $basicsRefRe.Matches($value)) {
      $name = $m.Groups[1].Value
      if (-not $controls.basics.ContainsKey($name)) {
        $lintErrors += "outputs.$($prop.Name): basics('$name') references an undefined basics control"
      }
    }
    foreach ($m in $stepsRefRe.Matches($value)) {
      $step    = $m.Groups[1].Value
      $element = $m.Groups[2].Value
      if (-not $controls.ContainsKey($step)) {
        $lintErrors += "outputs.$($prop.Name): steps('$step') references an undefined step"
      } elseif (-not $controls[$step].ContainsKey($element)) {
        $lintErrors += "outputs.$($prop.Name): steps('$step').$element references an undefined element in step '$step'"
      }
    }
  }
}

# ── Report ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==== createUiDefinition results ====" -ForegroundColor Cyan
$ok = $true
if ($structuralErrors.Count -gt 0) {
  $ok = $false
  Write-Host ("  Structural:    " + $structuralErrors.Count + " error(s)") -ForegroundColor Red
  foreach ($e in $structuralErrors) { Write-Host "    - $e" }
} else {
  Write-Host "  Structural:    OK" -ForegroundColor Green
}
if ($lintErrors.Count -gt 0) {
  $ok = $false
  Write-Host ("  Cross-ref:     " + $lintErrors.Count + " error(s)") -ForegroundColor Red
  foreach ($e in $lintErrors) { Write-Host "    - $e" }
} else {
  Write-Host "  Cross-ref:     OK" -ForegroundColor Green
}
if (-not $ok) { exit 1 }
exit 0
