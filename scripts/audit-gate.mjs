#!/usr/bin/env node
// Blocking npm advisory gate with an explicit, documented allowlist.
//
// `npm audit --audit-level=high` alone can't express "this advisory is known,
// unfixable without breaking changes, and tracked" — the job either fails or
// gets demoted to report-only, which hides *new* advisories too. This gate
// keeps the audit blocking: high/critical advisories fail the build unless
// their GHSA id is listed in scripts/audit-allowlist.json, where each entry
// must carry a reason. Allowlisted advisories are printed on every run so
// they stay visible until they can be removed.
//
// npm's legacy quick-audit endpoint is being retired and now rejects valid
// lockfiles after npm CLI's preferred bulk request fails. Read the lockfile and
// call the supported bulk endpoint directly so registry failures can be retried
// without silently falling back to the obsolete endpoint.
//
// Usage: node ../scripts/audit-gate.mjs   (cwd = the workspace to audit)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const allowlistPath = join(dirname(fileURLToPath(import.meta.url)), "audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const allowed = new Map(allowlist.map((e) => [e.ghsa, e.reason]));

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = {};
for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
  if (!packagePath || !entry.version) continue;
  const normalizedPath = packagePath.replaceAll("\\", "/");
  const markerIndex = normalizedPath.lastIndexOf("node_modules/");
  if (markerIndex < 0) continue;
  const installedPath = normalizedPath.slice(markerIndex + "node_modules/".length);
  const pathParts = installedPath.split("/");
  const packageName = entry.name ?? (
    pathParts[0]?.startsWith("@")
      ? pathParts.slice(0, 2).join("/")
      : pathParts[0]
  );
  if (!packageName) continue;
  packages[packageName] ??= [];
  if (!packages[packageName].includes(entry.version)) {
    packages[packageName].push(entry.version);
  }
}

const registry = execFileSync("npm", ["config", "get", "registry"], {
  encoding: "utf8",
}).trim().replace(/\/$/, "");
const endpoint = `${registry}/-/npm/v1/security/advisories/bulk`;

const report = {};
const packageEntries = Object.entries(packages);
// Smaller requests avoid the registry timing out on the frontend and add-in's
// large cross-platform lockfiles. Every chunk is still required to succeed.
for (let offset = 0; offset < packageEntries.length; offset += 250) {
  const batch = Object.fromEntries(packageEntries.slice(offset, offset + 250));
  let batchReport;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`registry returned HTTP ${response.status}`);
      }
      batchReport = await response.json();
      if (!batchReport || Array.isArray(batchReport) || typeof batchReport !== "object") {
        throw new Error("registry returned an invalid advisory report");
      }
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }

  if (!batchReport) {
    console.error("npm advisory request failed — refusing to pass the gate:");
    console.error(lastError instanceof Error ? lastError.message : String(lastError));
    process.exit(1);
  }
  for (const [packageName, packageAdvisories] of Object.entries(batchReport)) {
    report[packageName] = [
      ...(report[packageName] ?? []),
      ...(Array.isArray(packageAdvisories) ? packageAdvisories : []),
    ];
  }
}

const advisories = new Map(); // ghsa -> { severity, title, url }
for (const packageAdvisories of Object.values(report)) {
  if (!Array.isArray(packageAdvisories)) continue;
  for (const advisory of packageAdvisories) {
    if (!advisory?.url) continue;
    if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
    const ghsa = advisory.url.split("/").pop();
    advisories.set(ghsa, {
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
    });
  }
}

const blocking = [];
for (const [ghsa, adv] of advisories) {
  if (allowed.has(ghsa)) {
    console.log(`ALLOWLISTED ${adv.severity}: ${ghsa} — ${adv.title}`);
    console.log(`  reason: ${allowed.get(ghsa)}`);
  } else {
    blocking.push(`${adv.severity}: ${ghsa} — ${adv.title} (${adv.url})`);
  }
}

// The allowlist is shared across workspaces, so an entry unused here may
// still be load-bearing in the other workspace — flag it, don't fail on it.
const unused = allowlist.filter((e) => !advisories.has(e.ghsa));
for (const e of unused) {
  console.log(`note: allowlist entry ${e.ghsa} not reported in this workspace — remove it once no workspace reports it`);
}

if (blocking.length > 0) {
  console.error(`\n${blocking.length} high/critical advisories are not allowlisted:`);
  for (const line of blocking) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`audit gate passed (${advisories.size} high/critical advisories, all allowlisted)`);
