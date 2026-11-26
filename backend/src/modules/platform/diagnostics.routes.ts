// PostgREST + supabase-js diagnostic page.
//
// Open in a browser at GET /admin/diagnostics/postgrest. Runs a battery
// of focused tests against the deployed PostgREST and the supabase-js
// client wrapping it, with raw HTTP detail (status, headers, body) for
// every call.
//
// Designed to answer "is the bug in supabase-js, in our query, in
// PostgREST's schema cache, in role grants, or somewhere else?"
// without requiring code edits + redeploys for each hypothesis.
//
// Cleanup data: tests E and F insert+delete a sentinel user_profiles
// row keyed on user_id = '00000000-0000-0000-0000-DDDD0000DDDD'. If
// either fails partway, re-running the page will retry deletion.
//
// Auth (issue 025): the HTML pages fail closed. /postgrest and /inspect use
// DIAGNOSTICS_TOKEN: with it unset they respond 404, in every environment;
// otherwise ?token= must match it. Set it on a revision only while diagnosing,
// because that token travels in the URL. The health page at /diag uses
// DIAGNOSTICS_HEALTH_TOKEN, a passphrase typed into a form, so it is never in a
// URL; it is 404 too while that env var is unset. The chat inspector below uses
// application authentication on each route instead.

import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { chatInspectorRouter } from "../../altien/diagnostics/chatInspector";
import {
    inspectRows,
    runDiagnostics,
    runHealthChecks,
    type HealthResult,
    type HealthStatus,
    type TestResult,
} from "./platform.service";

export const diagnosticsRouter = Router();
diagnosticsRouter.use(chatInspectorRouter);

function tokenMatches(provided: unknown, expected: string): boolean {
    if (typeof provided !== "string") return false;
    // Hashing gives equal lengths, which timingSafeEqual requires.
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
}

function requireTokenFrom(envName: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const expected = (process.env[envName] ?? "").trim();
        if (!expected) {
            res.status(404).send("Not found");
            return;
        }
        if (!tokenMatches(req.query.token, expected)) {
            res.status(401).send(
                `<html><body style="font-family:monospace;padding:2rem"><h1>401 Unauthorized</h1><p>Missing or invalid ?token= parameter</p></body></html>`,
            );
            return;
        }
        next();
    };
}

const requireDiagnosticsToken = requireTokenFrom("DIAGNOSTICS_TOKEN");

function escape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function renderHtml(tests: TestResult[]): string {
    const passes = tests.filter((t) => t.status === "pass").length;
    const fails = tests.filter((t) => t.status === "fail").length;
    const infos = tests.filter((t) => t.status === "info").length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PostgREST diagnostics</title>
<style>
body { font-family: ui-monospace, Menlo, Consolas, monospace; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.4rem; }
.summary { padding: 0.75rem 1rem; background: #f6f8fa; border-radius: 6px; margin-bottom: 1.5rem; }
.test { border-left: 4px solid #ccc; padding: 0.75rem 1rem; margin-bottom: 1rem; background: #fafafa; }
.test.pass { border-color: #2da44e; }
.test.fail { border-color: #cf222e; background: #fff5f5; }
.test.info { border-color: #0969da; }
.test h2 { margin: 0 0 0.25rem; font-size: 1rem; }
.test .meta { font-size: 0.85rem; color: #666; }
.test .expected { font-size: 0.85rem; color: #555; margin: 0.25rem 0; }
.test .notes { font-size: 0.85rem; color: #cf222e; margin-top: 0.5rem; font-weight: 500; }
.test pre { background: #f6f8fa; padding: 0.5rem; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; max-height: 12rem; overflow-y: auto; }
.badge { display: inline-block; padding: 0 0.5rem; border-radius: 3px; font-size: 0.7rem; font-weight: bold; vertical-align: middle; }
.badge.pass { background: #2da44e; color: white; }
.badge.fail { background: #cf222e; color: white; }
.badge.info { background: #0969da; color: white; }
.kv { display: inline-block; margin-right: 1rem; font-size: 0.8rem; color: #666; }
</style>
</head>
<body>
<h1>PostgREST + supabase-js diagnostics</h1>
<div class="summary">
  ${passes} passing, ${fails} failing, ${infos} informational. Generated ${new Date().toISOString()}.
</div>
${tests
    .map(
        (t) => `
<div class="test ${t.status}">
  <h2><span class="badge ${t.status}">${t.status.toUpperCase()}</span> &nbsp; ${escape(t.id)} — ${escape(t.title)}</h2>
  <div class="meta">${escape(t.description)}</div>
  <div class="expected">Expected: ${escape(t.expected)}</div>
  ${t.httpStatus !== undefined ? `<div class="kv">HTTP: <strong>${t.httpStatus} ${escape(t.httpStatusText ?? "")}</strong></div>` : ""}
  ${t.error ? `<div class="kv">Error: <strong>${escape(t.error)}</strong></div>` : ""}
  ${t.headers ? `<details><summary class="meta">Response headers</summary><pre>${escape(JSON.stringify(t.headers, null, 2))}</pre></details>` : ""}
  ${t.body !== undefined ? `<pre>${escape(t.body)}</pre>` : ""}
  ${t.notes ? `<div class="notes">⚠ ${escape(t.notes)}</div>` : ""}
</div>`,
    )
    .join("")}
</body>
</html>`;
}

diagnosticsRouter.get("/postgrest", requireDiagnosticsToken, async (_req: Request, res: Response) => {
    try {
        const tests = await runDiagnostics();
        res.set("Content-Type", "text/html; charset=utf-8");
        res.send(renderHtml(tests));
    } catch (err) {
        res.status(500).send(
            `<html><body style="font-family:monospace;padding:2rem"><h1>500 Diagnostic page failed</h1><pre>${err instanceof Error ? err.stack : String(err)}</pre></body></html>`,
        );
    }
});

// General health page. Read-only, unlike /postgrest. It answers "what is wrong
// with this install?" without Entra sign-in, because an expired client secret
// breaks sign-in and /install too. Only its own passphrase protects it.
// DIAGNOSTICS_HEALTH_TOKEN is separate on purpose: turning this page on must not
// also unlock /postgrest, which writes, or /inspect, which returns rows.
//
//   GET  /diag                                          the passphrase form
//   POST /diag  passphrase=<DIAGNOSTICS_HEALTH_TOKEN>[&format=json]  the report
const STATUS_ORDER: HealthStatus[] = ["fail", "warn", "info", "skip", "pass"];

function healthSummary(checks: HealthResult[]): Record<HealthStatus, number> {
    const summary: Record<HealthStatus, number> = { fail: 0, warn: 0, info: 0, skip: 0, pass: 0 };
    for (const check of checks) summary[check.status] += 1;
    return summary;
}

function renderHealthCheck(check: HealthResult): string {
    const label = check.status.toUpperCase();
    const remediation = check.remediation ? `<div class="notes">${escape(check.remediation)}</div>` : "";
    return `
<div class="test ${check.status}">
  <h2><span class="badge ${check.status}">${label}</span> &nbsp; ${escape(check.title)}</h2>
  <div class="meta">${escape(check.detail)}</div>
  ${remediation}
  <div class="id">${escape(check.id)}</div>
</div>`;
}

function renderHealthHtml(checks: HealthResult[], generatedAt: string): string {
    const summary = healthSummary(checks);
    const counts = STATUS_ORDER.map((status) => `${summary[status]} ${status}`).join(", ");
    const needsAttention = STATUS_ORDER
        .filter((status) => status === "fail" || status === "warn")
        .flatMap((status) => checks.filter((check) => check.status === status));
    const attention = needsAttention.length
        ? `<h2 class="group">Needs attention</h2>${needsAttention.map(renderHealthCheck).join("")}`
        : "";
    const groups = [...new Set(checks.map((check) => check.group))];
    const allChecks = groups.map((group) => {
        const rows = checks.filter((check) => check.group === group).map(renderHealthCheck).join("");
        return `<h2 class="group">${escape(group)}</h2>${rows}`;
    }).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Mike health</title>
<style>
body { font-family: ui-monospace, Menlo, Consolas, monospace; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.4rem; }
.summary { padding: 0.75rem 1rem; background: #f6f8fa; border-radius: 6px; margin-bottom: 1.5rem; }
.group { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; }
.test { border-left: 4px solid #ccc; padding: 0.75rem 1rem; margin-bottom: 1rem; background: #fafafa; }
.test.pass { border-color: #2da44e; }
.test.fail { border-color: #cf222e; background: #fff5f5; }
.test.warn { border-color: #bf8700; background: #fffbea; }
.test.info { border-color: #0969da; }
.test h2 { margin: 0 0 0.25rem; font-size: 1rem; }
.test .meta { font-size: 0.85rem; color: #444; }
.test .notes { font-size: 0.85rem; color: #cf222e; margin-top: 0.5rem; font-weight: 500; }
.test .id { font-size: 0.75rem; color: #888; margin-top: 0.25rem; }
.badge { display: inline-block; padding: 0 0.5rem; border-radius: 3px; font-size: 0.7rem; font-weight: bold; vertical-align: middle; color: white; background: #6e7781; }
.badge.pass { background: #2da44e; }
.badge.fail { background: #cf222e; }
.badge.warn { background: #bf8700; }
.badge.info { background: #0969da; }
</style>
</head>
<body>
<h1>Mike health</h1>
<div class="summary">${counts}. Generated ${escape(generatedAt)}.</div>
${attention}
${allChecks}
</body>
</html>`;
}

function renderDiagForm(wrongPassphrase: boolean): string {
    const refusal = wrongPassphrase ? `<p class="refusal">Wrong passphrase</p>` : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Mike health</title>
<style>
body { font-family: ui-monospace, Menlo, Consolas, monospace; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.4rem; }
label { display: block; margin-bottom: 0.5rem; }
input { font-family: inherit; font-size: 1rem; padding: 0.4rem; width: 100%; box-sizing: border-box; margin-bottom: 1rem; }
button { font-family: inherit; padding: 0.5rem 1rem; background: #0969da; color: white; border: 0; border-radius: 4px; cursor: pointer; }
.refusal { color: #cf222e; font-weight: 500; }
</style>
</head>
<body>
<h1>Mike health</h1>
${refusal}
<form method="post" action="/diag">
  <label for="passphrase">Passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="off" required autofocus>
  <button type="submit">Check this install</button>
</form>
</body>
</html>`;
}

/** Mounted in app.ts ahead of the limiters and body parsers, so it covers their refusals too. */
export function setHealthHeaders(_req: Request, res: Response, next: NextFunction): void {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
}

function healthPassphrase(): string {
    return (process.env.DIAGNOSTICS_HEALTH_TOKEN ?? "").trim();
}

function requireHealthPassphraseConfigured(_req: Request, res: Response, next: NextFunction): void {
    if (!healthPassphrase()) {
        res.status(404).send("Not found");
        return;
    }
    next();
}

async function sendHealthReport(req: Request, res: Response): Promise<void> {
    let checks: HealthResult[];
    try {
        checks = await runHealthChecks({ requestHost: req.hostname });
    } catch {
        // The service isolates each check; this is the page's own last resort.
        checks = [{
            id: "page",
            group: "Page",
            title: "Health page",
            status: "fail",
            detail: "The checks could not run.",
            remediation: "Read the backend's console logs from the same time, then reload this page.",
        }];
    }
    const generatedAt = new Date().toISOString();
    if (req.body?.format === "json") {
        res.json({ generatedAt, summary: healthSummary(checks), checks });
        return;
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(renderHealthHtml(checks, generatedAt));
}

const DIAG_LIMIT_KEY = "diag";

/** A factory so each buildApp() gets its own failure count. */
export function createDiagRouter(): Router {
    const router = Router();
    // A passphrase people can remember is one people can guess. One constant key,
    // because the budget is for guesses at the one passphrase, from anywhere.
    // ponytail: the memory store is per replica, so the real limit is 10 x replicas.
    const attempts = new MemoryStore();
    const wrongPassphraseLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        store: attempts,
        keyGenerator: () => DIAG_LIMIT_KEY,
        legacyHeaders: false,
        message: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Mike health</title></head><body style="font-family:monospace;padding:2rem"><p>Too many wrong passphrases. Wait 15 minutes, then try again.</p></body></html>`,
    });

    router.get("/", requireHealthPassphraseConfigured, (_req: Request, res: Response) => {
        res.send(renderDiagForm(false));
    });

    router.post(
        "/",
        requireHealthPassphraseConfigured,
        wrongPassphraseLimiter,
        async (req: Request, res: Response) => {
            if (!tokenMatches(req.body?.passphrase, healthPassphrase())) {
                res.status(401).send(renderDiagForm(true));
                return;
            }
            // Before the checks, not on `finish`, which never fires if the client
            // disconnects: reloading during a slow report is not a wrong guess.
            await attempts.decrement(DIAG_LIMIT_KEY);
            await sendHealthReport(req, res);
        },
    );

    return router;
}

// Read-only table inspector. Lets us answer "what's actually stored in
// row X?" without adding console.log + redeploying.
//
//   GET /api/admin/diagnostics/inspect
//     ?token=<DIAGNOSTICS_TOKEN>
//     &table=projects                       (must be in allowlist below)
//     &filter={"id":"abc","user_id":"xyz"}  (JSON, eq-only — no operators)
//     &limit=20                             (capped at 100)
//
// Output: HTML table of rows + raw JSON pre. SELECT-only by construction
// (we use supabase-js .select() with no insert/update/delete). The
// allowlist + eq-only filter keep the surface small even if the token
// leaks. Sensitive secret-bearing tables (user_profiles holds API keys
// in cleartext columns) are deliberately excluded.
const INSPECT_ALLOWLIST = new Set<string>([
    "projects",
    "documents",
    "document_versions",
    "project_subfolders",
    "chats",
    "tabular_reviews",
    "tenants",
    "tenant_group_policies",
]);

const INSPECT_LIMIT_MAX = 100;

diagnosticsRouter.get("/inspect", requireDiagnosticsToken, async (req: Request, res: Response) => {
    const table = (req.query.table as string | undefined)?.trim() ?? "";
    const filterRaw = (req.query.filter as string | undefined) ?? "{}";
    const limitRaw = (req.query.limit as string | undefined) ?? "20";

    const errors: string[] = [];
    if (!table) errors.push("table is required");
    if (table && !INSPECT_ALLOWLIST.has(table))
        errors.push(`table '${escape(table)}' is not in the inspector allowlist`);

    let filter: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(filterRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            filter = parsed as Record<string, unknown>;
        } else {
            errors.push("filter must be a JSON object like {\"id\":\"...\"}");
        }
    } catch {
        errors.push("filter is not valid JSON");
    }

    const limit = Math.min(
        Math.max(1, parseInt(limitRaw, 10) || 20),
        INSPECT_LIMIT_MAX,
    );

    if (errors.length > 0) {
        res.set("Content-Type", "text/html; charset=utf-8");
        return void res.status(400).send(renderInspect({
            table, filter, limit,
            errors,
            rows: null, queryError: null,
        }));
    }

    const { rows, queryError } = await inspectRows(table, filter, limit);

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(renderInspect({ table, filter, limit, errors: [], rows, queryError }));
});

function renderInspect(params: {
    table: string;
    filter: Record<string, unknown>;
    limit: number;
    errors: string[];
    rows: Record<string, unknown>[] | null;
    queryError: string | null;
}): string {
    const { table, filter, limit, errors, rows, queryError } = params;
    const allowlist = [...INSPECT_ALLOWLIST].sort();
    const filterJson = JSON.stringify(filter, null, 2);

    const columns =
        rows && rows.length > 0 ? Object.keys(rows[0]) : [];
    const tableHtml =
        rows === null
            ? ""
            : rows.length === 0
              ? `<p>0 rows.</p>`
              : `<p>${rows.length} row${rows.length === 1 ? "" : "s"}.</p>
<table>
  <thead><tr>${columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead>
  <tbody>
    ${rows
        .map(
            (r) =>
                `<tr>${columns
                    .map((c) => {
                        const v = r[c];
                        const s =
                            v === null || v === undefined
                                ? "—"
                                : typeof v === "object"
                                  ? JSON.stringify(v)
                                  : String(v);
                        return `<td>${escape(s.length > 200 ? s.slice(0, 200) + "…" : s)}</td>`;
                    })
                    .join("")}</tr>`,
        )
        .join("")}
  </tbody>
</table>`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Inspect ${escape(table || "—")}</title>
<style>
body { font-family: ui-monospace, Menlo, Consolas, monospace; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.3rem; }
form { background: #f6f8fa; padding: 1rem; border-radius: 6px; margin-bottom: 1rem; display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; align-items: start; }
label { font-size: 0.85rem; color: #555; padding-top: 0.4rem; }
input[type=text], textarea { font-family: inherit; font-size: 0.9rem; padding: 0.4rem; width: 100%; box-sizing: border-box; }
textarea { min-height: 4rem; }
button { font-family: inherit; padding: 0.5rem 1rem; background: #0969da; color: white; border: 0; border-radius: 4px; cursor: pointer; }
.allowlist { font-size: 0.85rem; color: #666; }
.errors { color: #cf222e; background: #fff5f5; padding: 0.75rem 1rem; border-left: 4px solid #cf222e; margin-bottom: 1rem; }
.query-error { color: #cf222e; background: #fff5f5; padding: 0.5rem 0.75rem; border-radius: 4px; margin-bottom: 1rem; }
table { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; word-break: break-word; }
th { background: #f6f8fa; font-weight: 600; }
pre { background: #f6f8fa; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; }
</style></head><body>
<h1>Diagnostics — table inspector</h1>
<form method="get" action="">
  <input type="hidden" name="token" value="${escape((typeof process !== "undefined" && process.env.DIAGNOSTICS_TOKEN) ? "REDACTED" : "")}">
  <label for="table">table</label>
  <input id="table" name="table" type="text" value="${escape(table)}" list="tables" required>
  <datalist id="tables">${allowlist.map((t) => `<option value="${escape(t)}">`).join("")}</datalist>
  <label for="filter">filter (JSON, eq-only)</label>
  <textarea id="filter" name="filter">${escape(filterJson)}</textarea>
  <label for="limit">limit</label>
  <input id="limit" name="limit" type="text" value="${limit}">
  <span></span>
  <button type="submit">Inspect</button>
</form>
<div class="allowlist">Allowlist: ${allowlist.map((t) => `<code>${escape(t)}</code>`).join(", ")}.
The token is read from the request URL — keep it in your browser bar; this page does not echo it back into form values.</div>
${errors.length > 0 ? `<div class="errors">${errors.map((e) => `<div>${escape(e)}</div>`).join("")}</div>` : ""}
${queryError ? `<div class="query-error">Query error: ${escape(queryError)}</div>` : ""}
${tableHtml}
${rows && rows.length > 0 ? `<details><summary>raw JSON</summary><pre>${escape(JSON.stringify(rows, null, 2))}</pre></details>` : ""}
</body></html>`;
}
