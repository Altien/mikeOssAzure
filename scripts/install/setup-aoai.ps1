#!/usr/bin/env pwsh
# version: 1
<#
.SYNOPSIS
  Configure Azure OpenAI (or Azure AI Foundry) for Mike: either connect to an
  existing resource by URL + key, OR provision a fresh resource and a model
  deployment. Writes endpoint + key into Key Vault.

.DESCRIPTION
  Two operating modes selected by mutually exclusive switches:

  -ConnectExisting -Endpoint <url> -ApiKey <key>
    Validate the URL and key, write them to KV. Use when the customer
    already has an Azure OpenAI / Foundry resource elsewhere in their
    subscription (or even a different subscription, as long as the
    backend can reach it).

  -Provision -ResourceGroup <rg> -Region <region> -Model <gpt-...>
            [-DeploymentName <name>] [-Capacity <units>]
    Provision a new Azure OpenAI account in the named RG, create a
    deployment for the requested model, then write its endpoint + an
    API key to KV. Idempotent: if an account with the canonical name
    already exists in the RG, reuse it; if a deployment of the
    requested name already exists, reuse it.

  In both modes, the final state is:
    KV secret azure-openai-endpoint     = https://<account>.openai.azure.com/
    KV secret azure-openai-api-key      = <a key from the account>

.PARAMETER KeyVaultName
  Target Key Vault. Caller must already have Key Vault Secrets Officer.

.PARAMETER ConnectExisting
  Mode switch — connect to a resource the caller has already provisioned.

.PARAMETER Provision
  Mode switch — create a fresh resource + deployment.

.PARAMETER Endpoint
  Connect mode: the resource's endpoint (e.g. https://my-aoai.openai.azure.com/).

.PARAMETER ApiKey
  Connect mode: an API key for the resource.

.PARAMETER ResourceGroup
  Provision mode: target resource group. Must already exist.

.PARAMETER Region
  Provision mode: Azure region (e.g. uksouth, eastus, swedencentral). Pick a
  region with capacity for the requested model — quota varies sharply.

.PARAMETER Model
  Provision mode: model name (e.g. gpt-4o, gpt-4o-mini). The deployment is
  named the same as the model unless -DeploymentName overrides.

.PARAMETER AccountNamePrefix
  Provision mode: prefix for the new account name. Final name is
  "<prefix>-<6 random chars>". Default "mike".

.PARAMETER DeploymentName
  Provision mode: defaults to the model name. Set explicitly if you want
  a friendly alias (e.g. "fast" pointing at gpt-4o-mini).

.PARAMETER Capacity
  Provision mode: deployment capacity units. Default 30.

.EXAMPLE
  ./setup-aoai.ps1 -KeyVaultName kv-mike-example -ConnectExisting `
                   -Endpoint https://my-aoai.openai.azure.com/ `
                   -ApiKey ABCD1234...

.EXAMPLE
  ./setup-aoai.ps1 -KeyVaultName kv-mike-example -Provision `
                   -ResourceGroup rg-mike-example -Region uksouth `
                   -Model gpt-4o-mini
#>

[CmdletBinding(DefaultParameterSetName = "Connect")]
param(
    [Parameter(Mandatory = $true)][string]$KeyVaultName,

    [Parameter(ParameterSetName = "Connect")][switch]$ConnectExisting,
    [Parameter(ParameterSetName = "Connect")][string]$Endpoint,
    [Parameter(ParameterSetName = "Connect")][string]$ApiKey,

    [Parameter(ParameterSetName = "Provision")][switch]$Provision,
    [Parameter(ParameterSetName = "Provision")][string]$ResourceGroup,
    [Parameter(ParameterSetName = "Provision")][string]$Region,
    [Parameter(ParameterSetName = "Provision")][string]$Model,
    [Parameter(ParameterSetName = "Provision")][string]$AccountNamePrefix = "mike",
    [Parameter(ParameterSetName = "Provision")][string]$DeploymentName,
    [Parameter(ParameterSetName = "Provision")][int]$Capacity = 30
)

$ErrorActionPreference = "Stop"

function Set-KvSecret {
    param([string]$Name, [string]$Value)
    az keyvault secret set --vault-name $KeyVaultName --name $Name --value $Value --output none
}

function Validate-EndpointUrl {
    param([string]$Url)
    try {
        $uri = [System.Uri]$Url
        if ($uri.Scheme -ne "https") { throw "Endpoint must use https://" }
        if (-not $uri.Host)          { throw "Endpoint missing host" }
    } catch {
        throw "Invalid endpoint URL: $Url ($_)"
    }
}

# ── Connect mode ─────────────────────────────────────────────────────────────
if ($PSCmdlet.ParameterSetName -eq "Connect" -or $ConnectExisting) {
    if (-not $Endpoint) { throw "Connect mode requires -Endpoint" }
    if (-not $ApiKey)   { throw "Connect mode requires -ApiKey" }

    Validate-EndpointUrl $Endpoint
    # Trim trailing slash to keep KV value canonical.
    $normalized = $Endpoint.TrimEnd('/')

    Write-Host ""
    Write-Host "=== setup-aoai.ps1 (connect existing) ===" -ForegroundColor Cyan
    Write-Host "Endpoint:  $normalized"
    Write-Host "Key Vault: $KeyVaultName"

    Set-KvSecret -Name "azure-openai-endpoint" -Value $normalized
    Set-KvSecret -Name "azure-openai-api-key" -Value $ApiKey

    Write-Host ""
    Write-Host "=== Done ===" -ForegroundColor Green
    Write-Host "Refresh /install - AI provider items should reflect AOAI now." -ForegroundColor Cyan
    return
}

# ── Provision mode ───────────────────────────────────────────────────────────
if (-not $ResourceGroup) { throw "Provision mode requires -ResourceGroup" }
if (-not $Region)        { throw "Provision mode requires -Region" }
if (-not $Model)         { throw "Provision mode requires -Model" }
if (-not $DeploymentName) { $DeploymentName = $Model }

Write-Host ""
Write-Host "=== setup-aoai.ps1 (provision) ===" -ForegroundColor Cyan
Write-Host "RG:           $ResourceGroup"
Write-Host "Region:       $Region"
Write-Host "Model:        $Model"
Write-Host "Deployment:   $DeploymentName (capacity $Capacity)"
Write-Host "Key Vault:    $KeyVaultName"
Write-Host ""

# Idempotency: if a Cognitive Services account with a name starting
# $AccountNamePrefix already exists in this RG with kind=OpenAI, reuse it.
$existingAccount = az cognitiveservices account list `
    --resource-group $ResourceGroup `
    --query "[?kind=='OpenAI' && starts_with(name, '$AccountNamePrefix')] | [0]" `
    -o json | ConvertFrom-Json

if ($existingAccount) {
    Write-Host "[1/3] Reusing existing OpenAI account: $($existingAccount.name)" -ForegroundColor DarkGray
    $accountName = $existingAccount.name
} else {
    $suffix = [System.Guid]::NewGuid().ToString("N").Substring(0, 6)
    $accountName = "$AccountNamePrefix-aoai-$suffix"
    Write-Host "[1/3] Creating OpenAI account: $accountName" -ForegroundColor Cyan
    az cognitiveservices account create `
        --name $accountName `
        --resource-group $ResourceGroup `
        --location $Region `
        --kind OpenAI `
        --sku S0 `
        --custom-domain $accountName `
        --yes `
        --output none
}

# Deployment idempotency — does a deployment with this name already exist?
$existingDeployment = az cognitiveservices account deployment list `
    --name $accountName `
    --resource-group $ResourceGroup `
    --query "[?name=='$DeploymentName'] | [0]" `
    -o json | ConvertFrom-Json

if ($existingDeployment) {
    Write-Host "[2/3] Reusing existing deployment: $DeploymentName" -ForegroundColor DarkGray
} else {
    Write-Host "[2/3] Creating deployment $DeploymentName ($Model, capacity $Capacity)..." -ForegroundColor Cyan
    az cognitiveservices account deployment create `
        --name $accountName `
        --resource-group $ResourceGroup `
        --deployment-name $DeploymentName `
        --model-name $Model `
        --model-version "0125-preview" `
        --model-format OpenAI `
        --sku-capacity $Capacity `
        --sku-name "Standard" `
        --output none
    # Note: model-version is best-effort — Azure picks the closest available.
    # Operator can edit it later via the Azure portal.
}

# ── 3. Read out endpoint + key, write to KV ──────────────────────────────────
$endpoint = az cognitiveservices account show `
    --name $accountName `
    --resource-group $ResourceGroup `
    --query "properties.endpoint" -o tsv

$key = az cognitiveservices account keys list `
    --name $accountName `
    --resource-group $ResourceGroup `
    --query "key1" -o tsv

if (-not $endpoint -or -not $key) {
    throw "Failed to read endpoint + key from $accountName."
}

Write-Host "[3/3] Writing endpoint + key to KV..." -ForegroundColor Cyan
Set-KvSecret -Name "azure-openai-endpoint" -Value $endpoint.TrimEnd('/')
Set-KvSecret -Name "azure-openai-api-key" -Value $key

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Account:      $accountName"
Write-Host "Endpoint:     $endpoint"
Write-Host "Deployment:   $DeploymentName"
Write-Host ""
Write-Host "Refresh /install - AI provider items should reflect AOAI now." -ForegroundColor Cyan
