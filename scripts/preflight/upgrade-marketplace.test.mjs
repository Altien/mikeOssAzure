#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upgradeScript = join(repoRoot, "scripts/install/upgrade-marketplace.ps1");
const workDir = mkdtempSync(join(tmpdir(), "mike-upgrade-contract-"));
const fakeAz = join(workDir, "fake-az.ps1");
const callLog = join(workDir, "az-calls.jsonl");
const templateCapture = join(workDir, "telemetry-template.json");

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
  '${JSON.stringify(fakeBackend).replaceAll("'", "''")}'
  return
}
if ($command -match '^containerapp job show') {
  '{"name":"db-migrate"}'
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
  '{"properties":{"status":"Succeeded"}}'
  return
}
if ($command -match '^containerapp logs show') {
  '[telemetry] Application Insights initialised'
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

try {
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
                MIKE_FAKE_AZ_LOG: callLog,
                MIKE_TEMPLATE_CAPTURE: templateCapture,
            },
        },
    );

    if (result.status !== 0) {
        throw new Error(
            `Upgrade command failed (${result.status}).\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
        );
    }

    const calls = readFileSync(callLog, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const renderedCalls = calls.map((args) => args.join(" "));

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

    const template = JSON.parse(readFileSync(templateCapture, "utf8"));
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
} finally {
    rmSync(workDir, { recursive: true, force: true });
}
