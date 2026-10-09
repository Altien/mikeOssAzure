// Regression tests for the FAIL-CLOSED contract of scripts/pnpm-audit-gate.mjs.
//
// Run: node --test scripts/audit-gate.test.mjs
//
// Dev drift: upstream's tests target its npm + OSV `scripts/audit-gate.mjs`;
// Dev audits pnpm locks with `pnpm-audit-gate.mjs` instead (aa358966, sync of
// upstream dd91a85b), so these tests drive Dev's gate. The intent is the same
// as upstream's: the gate's only job is to refuse, so every path where "we
// could not check" must exit non-zero rather than print "audit gate passed".
//
// `pnpm audit` is replaced by a fake `corepack` on PATH that replays a canned
// report, so no test reaches a registry.

import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const gatePath = join(scriptsDir, "pnpm-audit-gate.mjs");
const allowlist = JSON.parse(readFileSync(join(scriptsDir, "audit-allowlist.json"), "utf8"));

const LOCKFILE = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";

// The fake: prints FAKE_PNPM_STDOUT, exits FAKE_PNPM_STATUS and records its
// argv so a test can prove what the gate asked for (or that it never asked).
const binDir = mkdtempSync(join(tmpdir(), "audit-gate-bin-"));
const fakePnpm = join(binDir, "fake-pnpm.mjs");
writeFileSync(fakePnpm, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.FAKE_PNPM_RECORD, JSON.stringify(process.argv.slice(2)));',
    'process.stdout.write(process.env.FAKE_PNPM_STDOUT ?? "");',
    'process.exitCode = Number(process.env.FAKE_PNPM_STATUS ?? "0");',
    "",
].join("\n"));
writeFileSync(join(binDir, "corepack.cmd"), `@"${process.execPath}" "${fakePnpm}" %*\r\n`);
const posixShim = join(binDir, "corepack");
writeFileSync(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${fakePnpm}" "$@"\n`);
chmodSync(posixShim, 0o755);
after(() => rmSync(binDir, { recursive: true, force: true }));

function envWithFakeCorepack(extra) {
    const env = { ...process.env, ...extra };
    // Windows keeps the variable as `Path`; replace whichever spelling exists.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${binDir}${delimiter}${env[pathKey] ?? ""}`;
    return env;
}

/**
 * Runs the gate in a fresh workspace. `lock` is the pnpm-lock.yaml content
 * (null = no lock file); `report` is what the fake `pnpm audit` prints.
 */
function runGate({ lock = LOCKFILE, report, status = 0 }) {
    const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
    if (lock !== null) writeFileSync(join(dir, "pnpm-lock.yaml"), lock);
    const record = join(dir, "pnpm-argv.json");
    const stdoutText = typeof report === "string" ? report : JSON.stringify(report ?? {});
    // spawn, never spawnSync: keeps the runner responsive while the gate runs.
    const child = spawn(process.execPath, [gatePath], {
        cwd: dir,
        env: envWithFakeCorepack({
            FAKE_PNPM_STDOUT: stdoutText,
            FAKE_PNPM_STATUS: String(status),
            FAKE_PNPM_RECORD: record,
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
            const argv = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null;
            rmSync(dir, { recursive: true, force: true });
            resolve({ status: code, stdout, stderr, argv });
        });
    });
}

function advisory(ghsa, severity = "high") {
    return {
        id: 1,
        title: `fixture ${ghsa}`,
        severity,
        url: `https://github.com/advisories/${ghsa}`,
    };
}

function assertRefused(result) {
    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stdout}\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
}

test("passes a clean report and audits the workspace at high severity", async () => {
    const result = await runGate({ report: { advisories: {}, metadata: {} } });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout.includes("audit gate passed (0 high/critical advisories)"), true);
    deepStrictEqual(result.argv, ["pnpm", "audit", "--json", "--audit-level=high"]);
});

test("fails without auditing when the workspace has no pnpm lock", async () => {
    const result = await runGate({ lock: null, report: { advisories: {} } });
    assertRefused(result);
    strictEqual(result.argv, null);
});

test("fails without auditing when the pnpm lock is empty", async () => {
    const result = await runGate({ lock: "", report: { advisories: {} } });
    assertRefused(result);
    strictEqual(result.stderr.includes("missing or empty"), true);
    strictEqual(result.argv, null);
});

test("fails when pnpm audit does not print JSON (proxy page, crash)", async () => {
    const result = await runGate({ report: "<html>captive portal</html>", status: 1 });
    assertRefused(result);
    strictEqual(result.stderr.includes("did not return JSON"), true);
});

test("fails on pnpm's error envelope instead of reading it as a clean tree", async () => {
    const result = await runGate({
        report: { error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "503" } },
        status: 1,
    });
    assertRefused(result);
    strictEqual(result.stderr.includes("pnpm audit failed"), true);
});

test("fails on a JSON answer with neither advisories nor vulnerabilities", async () => {
    const result = await runGate({ report: {} });
    assertRefused(result);
    strictEqual(result.stderr.includes("pnpm audit failed"), true);
});

test("fails when pnpm audit exits non-zero without a recognised advisory", async () => {
    const result = await runGate({ report: { advisories: {} }, status: 1 });
    assertRefused(result);
    strictEqual(result.stderr.includes("without recognized advisories"), true);
});

test("blocks a high advisory that is not allowlisted", async () => {
    const ghsa = "GHSA-0000-0000-0000";
    const result = await runGate({ report: { advisories: { 1: advisory(ghsa) } }, status: 1 });
    strictEqual(result.status, 1, result.stderr);
    strictEqual(result.stderr.includes(ghsa), true);
    strictEqual(result.stdout.includes("audit gate passed"), false);
});

test("blocks a critical advisory reported through vulnerabilities[].via", async () => {
    const ghsa = "GHSA-1111-1111-1111";
    const result = await runGate({
        report: { vulnerabilities: { pkg: { via: ["other-pkg", advisory(ghsa, "critical")] } } },
        status: 1,
    });
    strictEqual(result.status, 1, result.stderr);
    strictEqual(result.stderr.includes(`critical: ${ghsa}`), true);
});

test("fails when a high advisory carries no GHSA identifier", async () => {
    const result = await runGate({
        report: { advisories: { 1: { title: "no link", severity: "high", url: "https://example.test/x" } } },
        status: 1,
    });
    assertRefused(result);
    strictEqual(result.stderr.includes("lacks a GHSA URL"), true);
});

test("ignores moderate and low advisories", async () => {
    const result = await runGate({
        report: {
            advisories: {
                1: advisory("GHSA-2222-2222-2222", "moderate"),
                2: advisory("GHSA-3333-3333-3333", "low"),
            },
        },
    });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout.includes("audit gate passed (0 high/critical advisories)"), true);
});

test("passes an allowlisted advisory and prints its reason", { skip: allowlist.length === 0 }, async () => {
    const [entry] = allowlist;
    const result = await runGate({ report: { advisories: { 1: advisory(entry.ghsa) } }, status: 1 });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout.includes(`ALLOWLISTED high: ${entry.ghsa}`), true);
    strictEqual(result.stdout.includes("audit gate passed (1 high/critical advisories)"), true);
});
