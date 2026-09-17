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
// Auth: gated by passing ?token=<install-bootstrap-token> matching
// the KV secret of the same name. If that secret doesn't exist in KV,
// the page is accessible without a token (dev convenience). Production
// deployments should always have the bootstrap token set.

import { Router, type Request, type Response } from "express";
import { chatInspectorRouter } from "../../altien/diagnostics/chatInspector";
import { inspectRows, runDiagnostics, type TestResult } from "./platform.service";

export const diagnosticsRouter = Router();
diagnosticsRouter.use(chatInspectorRouter);

async function checkAuth(req: Request): Promise<{ ok: boolean; reason?: string }> {
    const provided = (req.query.token as string | undefined) ?? "";
    const expected = process.env.DIAGNOSTICS_TOKEN ?? "";
    if (!expected) return { ok: true };  // open if no token configured
    if (provided !== expected) {
        return { ok: false, reason: "Missing or invalid ?token= parameter" };
    }
    return { ok: true };
}

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

diagnosticsRouter.get("/postgrest", async (req: Request, res: Response) => {
    const auth = await checkAuth(req);
    if (!auth.ok) {
        return void res
            .status(401)
            .send(
                `<html><body style="font-family:monospace;padding:2rem"><h1>401 Unauthorized</h1><p>${auth.reason}</p></body></html>`,
            );
    }

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

diagnosticsRouter.get("/inspect", async (req: Request, res: Response) => {
    const auth = await checkAuth(req);
    if (!auth.ok) {
        return void res
            .status(401)
            .send(
                `<html><body style="font-family:monospace;padding:2rem"><h1>401 Unauthorized</h1><p>${auth.reason}</p></body></html>`,
            );
    }

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
