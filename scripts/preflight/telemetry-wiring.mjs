#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const templatePath = resolve(process.argv[2] ?? "marketplace/mainTemplate.json");
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const resources = [];

function collectResources(value) {
    if (Array.isArray(value)) {
        for (const item of value) collectResources(item);
        return;
    }

    if (!value || typeof value !== "object") return;

    if (typeof value.type === "string") {
        resources.push(value);
    }

    for (const child of Object.values(value)) {
        collectResources(child);
    }
}

collectResources(template);

const findResource = (type) =>
    resources.find((resource) => resource.type.toLowerCase() === type.toLowerCase());
const contains = (value, text) =>
    JSON.stringify(value).toLowerCase().includes(text.toLowerCase());

const workspace = findResource("Microsoft.OperationalInsights/workspaces");
const appInsights = findResource("Microsoft.Insights/components");
const appInsightsSecret = resources.find(
    (resource) =>
        resource.type.toLowerCase().includes("microsoft.keyvault/vaults/secrets") &&
        contains(resource, "appinsights-connection-string"),
);
const backendDeployment = resources.find(
    (resource) =>
        resource.type.toLowerCase() === "microsoft.resources/deployments" &&
        contains(resource, "Microsoft.App/containerApps") &&
        contains(resource, '"name":"backend"') &&
        contains(resource, "APPLICATIONINSIGHTS_CONNECTION_STRING"),
);
const backendUsesCliSafeSecretName =
    backendDeployment &&
    contains(backendDeployment, '"name":"appinsights-cs"') &&
    contains(backendDeployment, '"secretRef":"appinsights-cs"');
const containerAppsEnvironment = resources.find(
    (resource) =>
        resource.type.toLowerCase() === "microsoft.app/managedenvironments" &&
        contains(resource, "logAnalyticsConfiguration"),
);

const checks = [
    ["Log Analytics workspace is provisioned", Boolean(workspace)],
    ["Application Insights is provisioned", Boolean(appInsights)],
    ["Application Insights connection string is stored in Key Vault", Boolean(appInsightsSecret)],
    ["Backend receives APPLICATIONINSIGHTS_CONNECTION_STRING", Boolean(backendDeployment)],
    ["Backend uses a CLI-safe Container Apps secret name", Boolean(backendUsesCliSafeSecretName)],
    ["Container Apps console logs flow to Log Analytics", Boolean(containerAppsEnvironment)],
];

let failed = false;
for (const [label, passed] of checks) {
    console.log(`${passed ? "[ok]  " : "[fail]"} ${label}`);
    failed ||= !passed;
}

if (failed) {
    console.error(`Telemetry wiring preflight failed for ${templatePath}`);
    process.exit(1);
}

console.log(`Telemetry wiring preflight passed for ${templatePath}`);
