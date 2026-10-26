#!/usr/bin/env node
// Audit this workspace's pnpm lock and enforce dependency-scoped exceptions.
// Keep the active Dev entrypoint and transport; the graph check prevents a GHSA
// exception from applying to another package copy or newly added consumer.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedPnpm, loadPnpmAuditGraph, validateScopedAllowlist } from "./pnpm-audit-lock.mjs";

const allowlistPath = join(dirname(fileURLToPath(import.meta.url)), "audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
validateScopedAllowlist(allowlist);
const workspaceRoot = realpathSync(join(dirname(allowlistPath), ".."));
const workspace = relative(workspaceRoot, realpathSync(".")).replaceAll("\\", "/") || ".";
const graph = loadPnpmAuditGraph(realpathSync("."));
if (Object.keys(graph.packages).length === 0) {
  throw new Error("pnpm lock has no resolved packages; refusing to pass the audit gate");
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
  throw new Error("pnpm audit did not return JSON (" + run.status + "): " + run.stderr.slice(0, 500));
}
if (report.error || (!report.advisories && !report.vulnerabilities)) {
  throw new Error("pnpm audit failed (" + run.status + "): " + run.stderr.slice(0, 500));
}

const allowed = new Map(allowlist.map((entry) => [entry.ghsa, entry]));
const advisories = new Map();
function collect(advisory, packageHint) {
  if (!advisory || typeof advisory !== "object") return;
  const severity = advisory.severity;
  if (severity !== "high" && severity !== "critical") return;
  const url = advisory.url ?? advisory.link;
  const ghsa = typeof url === "string" ? /GHSA-[a-z0-9-]+/i.exec(url)?.[0] : null;
  if (!ghsa) throw new Error("High/critical pnpm advisory lacks a GHSA URL");
  const packageName = advisory.module_name ?? advisory.name ?? packageHint;
  const matches = [];
  for (const finding of advisory.findings ?? []) {
    if (typeof packageName === "string" && typeof finding?.version === "string") {
      matches.push({ name: packageName, version: finding.version });
    }
  }
  if (matches.length === 0 && typeof packageName === "string" && typeof advisory.version === "string") {
    matches.push({ name: packageName, version: advisory.version });
  }
  const previous = advisories.get(ghsa);
  advisories.set(ghsa, {
    severity,
    title: advisory.title ?? "Untitled advisory",
    url,
    matches: [...(previous?.matches ?? []), ...matches],
    unmatched: Boolean(previous?.unmatched || matches.length === 0),
  });
}
for (const advisory of Object.values(report.advisories ?? {})) collect(advisory);
for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "object") {
      collect({ ...via, findings: via.findings ?? vulnerability.findings }, vulnerability.name ?? packageName);
    }
  }
}

const blocking = [];
for (const [ghsa, advisory] of advisories) {
  const exception = allowed.get(ghsa);
  if (!advisory.unmatched && isAllowedPnpm(exception, advisory.matches, graph, workspace)) {
    console.log("ALLOWLISTED " + advisory.severity + ": " + ghsa + " — " + advisory.title);
    console.log("  reason: " + exception.reason);
  } else {
    blocking.push(advisory.severity + ": " + ghsa + " — " + advisory.title + " (" + advisory.url + ")" +
      (exception ? " — outside the approved dependency scope" : ""));
  }
}
for (const entry of allowlist.filter(({ ghsa }) => !advisories.has(ghsa))) {
  console.log("note: allowlist entry " + entry.ghsa + " not reported in this workspace");
}
if (blocking.length) {
  console.error(blocking.length + " high/critical advisories are not allowlisted:");
  for (const line of blocking) console.error("  " + line);
  process.exitCode = 1;
} else {
  if (run.status !== 0 && advisories.size === 0) {
    throw new Error("pnpm audit exited " + run.status + " without recognized advisories");
  }
  console.log("audit gate passed (" + advisories.size + " high/critical advisories)");
}
