#!/usr/bin/env node
// Audit the current workspace's pnpm lock. Transport and response-shape errors
// fail closed instead of being mistaken for an empty vulnerability report.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const allowlistPath = join(dirname(fileURLToPath(import.meta.url)), "audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const allowed = new Map(allowlist.map(({ ghsa, reason }) => [ghsa, reason]));
if (!readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8")) {
  throw new Error("The workspace pnpm lock is missing or empty");
}

const run = spawnSync("corepack", ["pnpm", "audit", "--json", "--audit-level=high"], {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: process.platform === "win32",
  maxBuffer: 64 * 1024 * 1024,
});
if (run.error) throw run.error;
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  throw new Error(`pnpm audit did not return JSON (${run.status}): ${run.stderr.slice(0, 500)}`);
}
if (report.error || (!report.advisories && !report.vulnerabilities)) {
  throw new Error(`pnpm audit failed (${run.status}): ${run.stderr.slice(0, 500)}`);
}

const advisories = new Map();
function collect(advisory) {
  if (!advisory || typeof advisory !== "object") return;
  const severity = advisory.severity;
  if (severity !== "high" && severity !== "critical") return;
  const url = advisory.url ?? advisory.link;
  const ghsa = typeof url === "string" ? /GHSA-[a-z0-9-]+/i.exec(url)?.[0] : null;
  if (!ghsa) throw new Error("High/critical pnpm advisory lacks a GHSA URL");
  advisories.set(ghsa, { severity, title: advisory.title ?? "Untitled advisory", url });
}
for (const advisory of Object.values(report.advisories ?? {})) collect(advisory);
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) collect(via);
}

const blocking = [];
for (const [ghsa, advisory] of advisories) {
  if (allowed.has(ghsa)) {
    console.log(`ALLOWLISTED ${advisory.severity}: ${ghsa} — ${advisory.title}`);
    console.log(`  reason: ${allowed.get(ghsa)}`);
  } else {
    blocking.push(`${advisory.severity}: ${ghsa} — ${advisory.title} (${advisory.url})`);
  }
}
for (const entry of allowlist.filter(({ ghsa }) => !advisories.has(ghsa))) {
  console.log(`note: allowlist entry ${entry.ghsa} not reported in this workspace`);
}
if (blocking.length) {
  console.error(`${blocking.length} high/critical advisories are not allowlisted:`);
  for (const line of blocking) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  if (run.status !== 0 && advisories.size === 0) {
    throw new Error(`pnpm audit exited ${run.status} without recognized advisories`);
  }
  console.log(`audit gate passed (${advisories.size} high/critical advisories)`);
}
