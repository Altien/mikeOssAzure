#requires -Version 7.0
# version: 1
<#
.SYNOPSIS
  Upgrade an existing Mike Marketplace installation without rotating customer secrets.

.DESCRIPTION
  Provisions the release's observability resources through a narrow incremental
  ARM deployment, connects the existing Container Apps environment to Log
  Analytics, runs database migrations, and then promotes the backend image.

  The full Marketplace template is deliberately not redeployed. Existing
  durable Key Vault secrets are outside this script's deployment template and
  cannot be overwritten by the upgrade.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [Parameter(Mandatory)]
    [string]$TargetVersion,

    [string]$BackendApp = "backend",
    [string]$MigrationJob = "db-migrate",
    [string]$PublisherRegistry = "acrmikeoss.azurecr.io",

    # Test seam for the Azure CLI. Customers should leave this as "az".
    [string]$AzCommand = "az",

    [ValidateRange(0, 60)]
    [int]$PollIntervalSeconds = 5,

    # Intended for automated contract tests only.
    [switch]$SkipHealthCheck
)

$ErrorActionPreference = "Stop"
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $output = & $AzCommand @Arguments 2>&1
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')`n$($output -join "`n")"
    }

    $text = ($output -join "`n").Trim()
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json -Depth 100
}

function Invoke-AzText {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $output = & $AzCommand @Arguments 2>&1
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return ($output -join "`n").Trim()
}

function Get-ContainerEnvironmentValue {
    param(
        [Parameter(Mandatory)]$Container,
        [Parameter(Mandatory)][string]$Name
    )

    $entry = @($Container.env) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    return [string]$entry.value
}

Write-Host "Mike Marketplace upgrade" -ForegroundColor Cyan
Write-Host "Resource group : $ResourceGroup"

$account = Invoke-AzJson @("account", "show", "--output", "json", "--only-show-errors")
if (-not $account.id) {
    throw "Azure CLI is not signed in. Run 'az login' and select the customer's subscription."
}
Write-Host "Subscription   : $($account.name) ($($account.id))"

$backend = Invoke-AzJson @(
    "containerapp", "show",
    "--name", $BackendApp,
    "--resource-group", $ResourceGroup,
    "--output", "json",
    "--only-show-errors"
)
if (-not $backend) {
    throw "Container App '$BackendApp' was not found in '$ResourceGroup'."
}

$container = @($backend.properties.template.containers) | Where-Object {
    $_.name -eq $BackendApp
} | Select-Object -First 1
if (-not $container) {
    $container = @($backend.properties.template.containers) | Select-Object -First 1
}
if (-not $container) {
    throw "Container App '$BackendApp' has no container definition."
}

$location = [string]$backend.location
$environmentId = [string]$backend.properties.environmentId
$environmentName = ($environmentId -split "/")[-1]
$keyVaultName = Get-ContainerEnvironmentValue -Container $container -Name "KEY_VAULT_NAME"
$fqdn = [string]$backend.properties.configuration.ingress.fqdn
$previousImage = [string]$container.image

if ($TargetVersion -notmatch '^[A-Za-z0-9_.-]+$') {
    throw "TargetVersion '$TargetVersion' is not a valid container image tag."
}

$supportedSourceVersions = @("1.0.9", "1.0.10")
$expectedImageRepository = "$PublisherRegistry/backend"
$escapedImageRepository = [regex]::Escape($expectedImageRepository)
if ($previousImage -notmatch "^$escapedImageRepository`:(?<tag>[A-Za-z0-9_.-]+)$") {
    throw "Current backend image '$previousImage' is not a supported Marketplace image from '$expectedImageRepository'. Stop and contact Mike support."
}
$previousVersion = [string]$Matches.tag
if ($previousVersion -notin $supportedSourceVersions) {
    throw "Upgrade from backend version '$previousVersion' is not supported by this script. Supported starting versions: $($supportedSourceVersions -join ', '). No Azure resources were changed."
}
Write-Host "Target version : $TargetVersion"
Write-Host "Current version: $previousVersion"

if (-not $location -or -not $environmentName -or -not $keyVaultName) {
    throw "Could not discover location, Container Apps environment, or Key Vault from '$BackendApp'."
}
if ($keyVaultName -notmatch '^kv-mike-(?<suffix>.+)$') {
    throw "Key Vault '$keyVaultName' does not use the expected kv-mike-<env> naming convention."
}
$environmentSuffix = $Matches.suffix

$identityIds = @($backend.identity.userAssignedIdentities.PSObject.Properties.Name)
$identityId = $identityIds | Where-Object { $_ -match '/mi-mike-' } | Select-Object -First 1
if (-not $identityId -and $identityIds.Count -eq 1) {
    $identityId = $identityIds[0]
}
if (-not $identityId) {
    throw "Could not identify the backend's user-assigned managed identity."
}

$migrationJobDefinition = Invoke-AzJson @(
    "containerapp", "job", "show",
    "--name", $MigrationJob,
    "--resource-group", $ResourceGroup,
    "--output", "json",
    "--only-show-errors"
)
$migrationContainer = @($migrationJobDefinition.properties.template.containers) |
    Select-Object -First 1
$previousMigrationImage = [string]$migrationContainer.image
if (-not $previousMigrationImage) {
    throw "Migration job '$MigrationJob' has no container image to restore if the upgrade fails."
}

$workspaceName = "law-mike-$environmentSuffix"
$appInsightsName = "appi-mike-$environmentSuffix"
$targetImage = "$PublisherRegistry/backend:$TargetVersion"

# This narrowly scoped template creates only the three telemetry resources.
# It cannot update any pre-existing durable secret because none are declared.
$telemetryTemplate = [ordered]@{
    '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
    contentVersion = "1.0.0.0"
    parameters = [ordered]@{
        location = @{ type = "string" }
        workspaceName = @{ type = "string" }
        appInsightsName = @{ type = "string" }
        keyVaultName = @{ type = "string" }
    }
    resources = @(
        [ordered]@{
            type = "Microsoft.OperationalInsights/workspaces"
            apiVersion = "2025-07-01"
            name = "[parameters('workspaceName')]"
            location = "[parameters('location')]"
            properties = [ordered]@{
                sku = @{ name = "PerGB2018" }
                retentionInDays = 30
                workspaceCapping = @{ dailyQuotaGb = 1 }
            }
        },
        [ordered]@{
            type = "Microsoft.Insights/components"
            apiVersion = "2020-02-02"
            name = "[parameters('appInsightsName')]"
            location = "[parameters('location')]"
            kind = "web"
            properties = [ordered]@{
                Application_Type = "web"
                WorkspaceResourceId = "[resourceId('Microsoft.OperationalInsights/workspaces', parameters('workspaceName'))]"
                publicNetworkAccessForIngestion = "Enabled"
                publicNetworkAccessForQuery = "Enabled"
            }
            dependsOn = @(
                "[resourceId('Microsoft.OperationalInsights/workspaces', parameters('workspaceName'))]"
            )
        },
        [ordered]@{
            type = "Microsoft.KeyVault/vaults/secrets"
            apiVersion = "2025-05-01"
            name = "[format('{0}/{1}', parameters('keyVaultName'), 'appinsights-connection-string')]"
            properties = [ordered]@{
                value = "[reference(resourceId('Microsoft.Insights/components', parameters('appInsightsName')), '2020-02-02').ConnectionString]"
            }
            dependsOn = @(
                "[resourceId('Microsoft.Insights/components', parameters('appInsightsName'))]"
            )
        }
    )
}

$templatePath = Join-Path ([IO.Path]::GetTempPath()) "mike-telemetry-$([Guid]::NewGuid().ToString('N')).json"
$migrationUpdateAttempted = $false
$migrationStarted = $false
$backendPromotionAttempted = $false
try {
    try {
        $telemetryTemplate |
            ConvertTo-Json -Depth 100 |
            Set-Content -LiteralPath $templatePath -Encoding utf8NoBOM

        Write-Host "[1/6] Provisioning Application Insights and Log Analytics" -ForegroundColor Cyan
        Invoke-AzJson @(
            "deployment", "group", "create",
            "--name", "mike-observability-upgrade",
            "--resource-group", $ResourceGroup,
            "--template-file", $templatePath,
            "--parameters",
            "location=$location",
            "workspaceName=$workspaceName",
            "appInsightsName=$appInsightsName",
            "keyVaultName=$keyVaultName",
            "--output", "json",
            "--only-show-errors"
        ) | Out-Null
    } finally {
        Remove-Item -LiteralPath $templatePath -Force -ErrorAction SilentlyContinue
    }

    $workspace = Invoke-AzJson @(
        "monitor", "log-analytics", "workspace", "show",
        "--workspace-name", $workspaceName,
        "--resource-group", $ResourceGroup,
        "--output", "json",
        "--only-show-errors"
    )
    $workspaceKeys = Invoke-AzJson @(
        "monitor", "log-analytics", "workspace", "get-shared-keys",
        "--workspace-name", $workspaceName,
        "--resource-group", $ResourceGroup,
        "--output", "json",
        "--only-show-errors"
    )

    Write-Host "[2/6] Connecting Container Apps logs to Log Analytics" -ForegroundColor Cyan
    Invoke-AzJson @(
        "containerapp", "env", "update",
        "--name", $environmentName,
        "--resource-group", $ResourceGroup,
        "--logs-destination", "log-analytics",
        "--logs-workspace-id", ([string]$workspace.customerId),
        "--logs-workspace-key", ([string]$workspaceKeys.primarySharedKey),
        "--output", "json",
        "--only-show-errors"
    ) | Out-Null

    $keyVaultSecretUri = "https://$keyVaultName.vault.azure.net/secrets/appinsights-connection-string"
    Write-Host "[3/6] Wiring backend telemetry through Key Vault" -ForegroundColor Cyan
    Invoke-AzJson @(
        "containerapp", "secret", "set",
        "--name", $BackendApp,
        "--resource-group", $ResourceGroup,
        "--secrets", "appinsights-cs=keyvaultref:$keyVaultSecretUri,identityref:$identityId",
        "--output", "json",
        "--only-show-errors"
    ) | Out-Null

    Write-Host "[4/6] Running database migrations with $targetImage" -ForegroundColor Cyan
    $migrationUpdateAttempted = $true
    Invoke-AzJson @(
        "containerapp", "job", "update",
        "--name", $MigrationJob,
        "--resource-group", $ResourceGroup,
        "--image", $targetImage,
        "--output", "json",
        "--only-show-errors"
    ) | Out-Null
    $migrationStarted = $true
    $execution = Invoke-AzJson @(
        "containerapp", "job", "start",
        "--name", $MigrationJob,
        "--resource-group", $ResourceGroup,
        "--output", "json",
        "--only-show-errors"
    )
    $executionName = [string]$execution.name
    if (-not $executionName) {
        throw "Migration job did not return an execution name."
    }

    $deadline = (Get-Date).AddMinutes(10)
    do {
        if ($PollIntervalSeconds -gt 0) {
            Start-Sleep -Seconds $PollIntervalSeconds
        }
        $executionState = Invoke-AzJson @(
            "containerapp", "job", "execution", "show",
            "--name", $MigrationJob,
            "--resource-group", $ResourceGroup,
            "--job-execution-name", $executionName,
            "--output", "json",
            "--only-show-errors"
        )
        $migrationStatus = [string]$executionState.properties.status
        Write-Host "  migration status: $migrationStatus"
        if ($migrationStatus -eq "Succeeded") { break }
        if ($migrationStatus -in @("Failed", "Degraded", "Stopped", "Cancelled")) {
            throw "Migration execution '$executionName' ended with status '$migrationStatus'. Backend was not promoted."
        }
        if ((Get-Date) -gt $deadline) {
            throw "Migration execution '$executionName' did not finish within 10 minutes."
        }
    } while ($true)

    Write-Host "[5/6] Promoting backend to $targetImage" -ForegroundColor Cyan
    $backendPromotionAttempted = $true
    Invoke-AzJson @(
        "containerapp", "update",
        "--name", $BackendApp,
        "--resource-group", $ResourceGroup,
        "--image", $targetImage,
        "--set-env-vars", "APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights-cs",
        "--output", "json",
        "--only-show-errors"
    ) | Out-Null

    Write-Host "[6/6] Verifying health and telemetry" -ForegroundColor Cyan
    if (-not $SkipHealthCheck) {
        $healthy = $false
        for ($attempt = 1; $attempt -le 6; $attempt++) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri "https://$fqdn/api/health" -TimeoutSec 10
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                    $healthy = $true
                    break
                }
            } catch {
                if ($attempt -lt 6) { Start-Sleep -Seconds 5 }
            }
        }
        if (-not $healthy) {
            throw "Backend health check failed after promotion."
        }
    }

    $telemetryReady = $false
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        $logs = Invoke-AzText @(
            "containerapp", "logs", "show",
            "--name", $BackendApp,
            "--resource-group", $ResourceGroup,
            "--tail", "100",
            "--only-show-errors"
        )
        if ($logs -match '\[telemetry\] Application Insights initialised') {
            $telemetryReady = $true
            break
        }
        if ($attempt -lt 6 -and $PollIntervalSeconds -gt 0) {
            Start-Sleep -Seconds $PollIntervalSeconds
        }
    }
    if (-not $telemetryReady) {
        throw "Backend is running but did not report Application Insights initialisation."
    }
} catch {
    $upgradeError = $_
    $rollbackErrors = [Collections.Generic.List[string]]::new()

    if ($backendPromotionAttempted) {
        Write-Warning "Upgrade failed. Restoring the previous backend image: $previousImage"
        try {
            Invoke-AzJson @(
                "containerapp", "update",
                "--name", $BackendApp,
                "--resource-group", $ResourceGroup,
                "--image", $previousImage,
                "--output", "json",
                "--only-show-errors"
            ) | Out-Null
        } catch {
            $rollbackErrors.Add("backend image: $($_.Exception.Message)")
        }
    }

    if ($migrationUpdateAttempted) {
        Write-Warning "Restoring the migration job image: $previousMigrationImage"
        try {
            Invoke-AzJson @(
                "containerapp", "job", "update",
                "--name", $MigrationJob,
                "--resource-group", $ResourceGroup,
                "--image", $previousMigrationImage,
                "--output", "json",
                "--only-show-errors"
            ) | Out-Null
        } catch {
            $rollbackErrors.Add("migration job image: $($_.Exception.Message)")
        }
    }

    if ($migrationStarted) {
        Write-Warning "Database migrations and additive telemetry resources are not removed automatically. The released migrations are backward-compatible; use Azure PostgreSQL point-in-time restore if a full database rollback is required."
    }
    if ($rollbackErrors.Count -gt 0) {
        throw "Upgrade failed: $($upgradeError.Exception.Message)`nAutomatic rollback also failed for: $($rollbackErrors -join '; ')"
    }
    throw $upgradeError
}

Write-Host ""
Write-Host "Upgrade succeeded." -ForegroundColor Green
Write-Host "Backend image : $targetImage"
Write-Host "Application Insights: $appInsightsName"
Write-Host "Log Analytics: $workspaceName"
Write-Host "No existing durable Key Vault secret was read or rewritten."
