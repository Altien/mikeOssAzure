#!/usr/bin/env node

import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upgradeScript = join(repoRoot, "scripts/install/upgrade-marketplace.ps1");
const workDir = mkdtempSync(join(tmpdir(), "mike-upgrade-contract-"));
const fakeAz = join(workDir, "fake-az.ps1");

const fakeBackend = {
    location: "uksouth",
    identity: {
        type: "UserAssigned",
        userAssignedIdentities: {
            "/subscriptions/sub/resourceGroups/rg-customer/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-mike-prod":
                {},
        },
    },
    properties: {
        environmentId:
            "/subscriptions/sub/resourceGroups/rg-customer/providers/Microsoft.App/managedEnvironments/cae-mike-prod",
        configuration: {
            ingress: { fqdn: "backend.example.test" },
        },
        template: {
            containers: [
                {
                    name: "backend",
                    image: "acrmikeoss.azurecr.io/backend:1.0.10",
                    env: [
                        { name: "KEY_VAULT_NAME", value: "kv-mike-prod" },
                    ],
                },
            ],
        },
    },
};

writeFileSync(
    fakeAz,
    `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
$ErrorActionPreference = "Stop"
Add-Content -LiteralPath $env:MIKE_FAKE_AZ_LOG -Value ($CliArgs | ConvertTo-Json -Compress)
$command = $CliArgs -join " "

if ($command -match '^account show') {
  '${JSON.stringify({ id: "sub", name: "Customer subscription" }).replaceAll("'", "''")}'
  return
}
if ($command -match '^containerapp show') {
  $backend = '${JSON.stringify(fakeBackend).replaceAll("'", "''")}' | ConvertFrom-Json -Depth 100
  if ($env:MIKE_FAKE_SOURCE_IMAGE) {
    $backend.properties.template.containers[0].image = $env:MIKE_FAKE_SOURCE_IMAGE
  }
  $backend | ConvertTo-Json -Depth 100 -Compress
  return
}
if ($command -match '^containerapp job show') {
  $jobImage = if ($env:MIKE_FAKE_JOB_IMAGE) { $env:MIKE_FAKE_JOB_IMAGE } else { 'acrmikeoss.azurecr.io/backend:1.0.10' }
  @{ name = 'db-migrate'; properties = @{ template = @{ containers = @(@{ name = 'migrate'; image = $jobImage }) } } } |
    ConvertTo-Json -Depth 100 -Compress
  return
}
if ($command -match '^deployment group create') {
  $templateIndex = [Array]::IndexOf($CliArgs, '--template-file')
  Copy-Item -LiteralPath $CliArgs[$templateIndex + 1] -Destination $env:MIKE_TEMPLATE_CAPTURE -Force
  '{"properties":{"provisioningState":"Succeeded"}}'
  return
}
if ($command -match '^monitor log-analytics workspace show') {
  '{"customerId":"workspace-customer-id"}'
  return
}
if ($command -match '^monitor log-analytics workspace get-shared-keys') {
  '{"primarySharedKey":"workspace-shared-key"}'
  return
}
if ($command -match '^containerapp job start') {
  '{"name":"execution-1"}'
  return
}
if ($command -match '^containerapp job execution show') {
  $status = if ($env:MIKE_FAKE_MIGRATION_STATUS) { $env:MIKE_FAKE_MIGRATION_STATUS } else { 'Succeeded' }
  @{ properties = @{ status = $status } } | ConvertTo-Json -Compress
  return
}
if ($command -match '^containerapp logs show') {
  if ($env:MIKE_FAKE_TELEMETRY_READY -eq 'false') {
    '[telemetry] disabled'
  } else {
    '[telemetry] Application Insights initialised'
  }
  return
}

'{}'
return
`,
    "utf8",
);

function collectResources(value, output = []) {
    if (Array.isArray(value)) {
        for (const item of value) collectResources(item, output);
    } else if (value && typeof value === "object") {
        if (typeof value.type === "string") output.push(value);
        for (const child of Object.values(value)) collectResources(child, output);
    }
    return output;
}

function runUpgrade(name, extraEnv = {}) {
    const scenarioCallLog = join(workDir, `${name}-az-calls.jsonl`);
    const scenarioTemplateCapture = join(workDir, `${name}-telemetry-template.json`);
    const result = spawnSync(
        "pwsh",
        [
            "-NoProfile",
            "-File",
            upgradeScript,
            "-ResourceGroup",
            "rg-customer",
            "-TargetVersion",
            "1.0.11",
            "-AzCommand",
            fakeAz,
            "-PollIntervalSeconds",
            "0",
            "-SkipHealthCheck",
        ],
        {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                MIKE_FAKE_AZ_LOG: scenarioCallLog,
                MIKE_TEMPLATE_CAPTURE: scenarioTemplateCapture,
                ...extraEnv,
            },
        },
    );

    const calls = existsSync(scenarioCallLog)
        ? readFileSync(scenarioCallLog, "utf8")
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];

    return {
        result,
        calls,
        renderedCalls: calls.map((args) => args.join(" ")),
        templateCapture: scenarioTemplateCapture,
    };
}

try {
    const success = runUpgrade("success");
    const { result } = success;

    if (result.status !== 0) {
        throw new Error(
            `Upgrade command failed (${result.status}).\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
        );
    }

    const { renderedCalls } = success;

    const migrationStart = renderedCalls.findIndex((call) =>
        call.startsWith("containerapp job start"),
    );
    const backendPromote = renderedCalls.findIndex(
        (call) =>
            call.startsWith("containerapp update") &&
            call.includes("acrmikeoss.azurecr.io/backend:1.0.11"),
    );
    if (migrationStart < 0 || backendPromote < 0 || migrationStart > backendPromote) {
        throw new Error("Upgrade must complete migrations before promoting the backend.");
    }

    const expectedCalls = [
        "deployment group create",
        "containerapp env update",
        "containerapp secret set",
        "APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights-cs",
    ];
    for (const expected of expectedCalls) {
        if (!renderedCalls.some((call) => call.includes(expected))) {
            throw new Error(`Missing upgrade action: ${expected}`);
        }
    }

    const durableSecrets = [
        "install-bootstrap-token",
        "postgrest-jwt-secret",
        "auth-state-secret",
        "pgrst-authenticator-password",
        "mcp-connectors-encryption-key",
        "download-signing-secret",
    ];
    for (const secret of durableSecrets) {
        if (renderedCalls.some((call) => call.includes(secret))) {
            throw new Error(`Upgrade must not read or write durable secret: ${secret}`);
        }
    }

    const template = JSON.parse(readFileSync(success.templateCapture, "utf8"));
    const resources = collectResources(template);
    const resourceTypes = resources.map((resource) => resource.type.toLowerCase());
    for (const required of [
        "microsoft.operationalinsights/workspaces",
        "microsoft.insights/components",
        "microsoft.keyvault/vaults/secrets",
    ]) {
        if (!resourceTypes.includes(required)) {
            throw new Error(`Telemetry upgrade template is missing ${required}`);
        }
    }

    const templateText = JSON.stringify(template).toLowerCase();
    for (const secret of durableSecrets) {
        if (templateText.includes(secret)) {
            throw new Error(`Telemetry template must not contain durable secret: ${secret}`);
        }
    }
    if (!templateText.includes("appinsights-connection-string")) {
        throw new Error("Telemetry template must create the App Insights Key Vault secret.");
    }

    console.log("[ok] upgrade provisions telemetry automatically");
    console.log("[ok] migrations finish before backend promotion");
    console.log("[ok] durable customer secrets are untouched");

    const unsupported = runUpgrade("unsupported", {
        MIKE_FAKE_SOURCE_IMAGE: "acrmikeoss.azurecr.io/backend:1.0.8",
        MIKE_FAKE_JOB_IMAGE: "acrmikeoss.azurecr.io/backend:1.0.8",
    });
    if (unsupported.result.status === 0) {
        throw new Error("Upgrade must reject unsupported starting versions.");
    }
    const unsupportedOutput = `${unsupported.result.stdout}\n${unsupported.result.stderr}`;
    if (
        !unsupportedOutput.includes("Supported starting versions: 1.0.9,") ||
        !unsupportedOutput.includes("1.0.10. No Azure resources were changed.")
    ) {
        throw new Error(
            `Unsupported-version error must list the supported starting versions.\n${unsupported.result.stdout}\n${unsupported.result.stderr}`,
        );
    }
    if (
        unsupported.renderedCalls.some(
            (call) =>
                call.startsWith("deployment group create") ||
                call.startsWith("containerapp job show") ||
                call.startsWith("containerapp update"),
        )
    ) {
        throw new Error("Unsupported-version rejection must happen before any Azure mutation.");
    }
    console.log("[ok] unsupported starting versions stop before Azure mutation");

    const verificationFailure = runUpgrade("verification-failure", {
        MIKE_FAKE_TELEMETRY_READY: "false",
    });
    if (verificationFailure.result.status === 0) {
        throw new Error("Upgrade must fail when telemetry verification fails.");
    }
    const rollbackBackend = verificationFailure.renderedCalls.find(
        (call) =>
            call.startsWith("containerapp update") &&
            call.includes("--image acrmikeoss.azurecr.io/backend:1.0.10"),
    );
    const rollbackJob = verificationFailure.renderedCalls.find(
        (call) =>
            call.startsWith("containerapp job update") &&
            call.includes("--image acrmikeoss.azurecr.io/backend:1.0.10"),
    );
    if (!rollbackBackend || !rollbackJob) {
        throw new Error(
            "Verification failure must restore both backend and migration-job images.",
        );
    }
    const failureOutput = `${verificationFailure.result.stdout}\n${verificationFailure.result.stderr}`;
    if (
        !failureOutput.includes("Database migrations and additive telemetry resources are not removed automatically") ||
        !failureOutput.includes("point-in-time restore")
    ) {
        throw new Error("Rollback output must state the database and telemetry boundary.");
    }
    console.log("[ok] verification failure restores both deployed image references");
    console.log("[ok] rollback output states the database/telemetry boundary");

    const migrationFailure = runUpgrade("migration-failure", {
        MIKE_FAKE_MIGRATION_STATUS: "Failed",
    });
    if (migrationFailure.result.status === 0) {
        throw new Error("Upgrade must fail when database migration fails.");
    }
    if (
        migrationFailure.renderedCalls.some((call) =>
            call.startsWith("containerapp update"),
        )
    ) {
        throw new Error("Migration failure must not promote or roll back an unchanged backend.");
    }
    if (
        !migrationFailure.renderedCalls.some(
            (call) =>
                call.startsWith("containerapp job update") &&
                call.includes("--image acrmikeoss.azurecr.io/backend:1.0.10"),
        )
    ) {
        throw new Error("Migration failure must restore the migration-job image.");
    }
    console.log("[ok] migration failure leaves backend untouched and restores the job image");
} finally {
    rmSync(workDir, { recursive: true, force: true });
}
