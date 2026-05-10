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
import { createServerSupabase } from "../lib/supabase";
import { getConfig, flushConfigCache } from "../lib/config";

export const diagnosticsRouter = Router();

const SENTINEL_USER_ID = "00000000-0000-0000-0000-dddd0000dddd";

type TestResult = {
    id: string;
    title: string;
    description: string;
    expected: string;
    status: "pass" | "fail" | "info";
    httpStatus?: number;
    httpStatusText?: string;
    headers?: Record<string, string>;
    body?: string;
    error?: string;
    notes?: string;
};

async function checkAuth(req: Request): Promise<{ ok: boolean; reason?: string }> {
    const provided = (req.query.token as string | undefined) ?? "";
    const expected = process.env.DIAGNOSTICS_TOKEN ?? "";
    if (!expected) return { ok: true };  // open if no token configured
    if (provided !== expected) {
        return { ok: false, reason: "Missing or invalid ?token= parameter" };
    }
    return { ok: true };
}

async function rawFetch(
    url: string,
    init?: RequestInit,
): Promise<{
    httpStatus: number;
    httpStatusText: string;
    headers: Record<string, string>;
    body: string;
}> {
    const resp = await fetch(url, init);
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
        headers[k] = v;
    });
    return {
        httpStatus: resp.status,
        httpStatusText: resp.statusText,
        headers,
        body: (await resp.text()).slice(0, 2000),
    };
}

async function runDiagnostics(): Promise<TestResult[]> {
    const baseUrl = process.env.SUPABASE_URL ?? "";
    const tests: TestResult[] = [];

    // ── A. Raw GET, Accept: application/json
    try {
        const r = await rawFetch(
            `${baseUrl}/user_profiles?select=user_id,email,display_name&limit=1`,
            { headers: { Accept: "application/json" } },
        );
        tests.push({
            id: "A",
            title: "Raw GET /user_profiles, Accept: application/json",
            description: "Plain HTTP fetch, default Accept. Confirms the table exists, role can SELECT, schema cache knows the columns.",
            expected: "200 OK with array body (possibly empty [])",
            status: r.httpStatus === 200 ? "pass" : "fail",
            ...r,
        });
    } catch (err) {
        tests.push({
            id: "A",
            title: "Raw GET /user_profiles, Accept: application/json",
            description: "Plain HTTP fetch, default Accept.",
            expected: "200 OK with array body",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── B. Raw GET, Accept: vnd.pgrst.object+json (the supabase-js maybeSingle header)
    try {
        const r = await rawFetch(
            `${baseUrl}/user_profiles?select=user_id&user_id=eq.${SENTINEL_USER_ID}`,
            { headers: { Accept: "application/vnd.pgrst.object+json" } },
        );
        tests.push({
            id: "B",
            title: "Raw GET with Accept: application/vnd.pgrst.object+json (zero rows)",
            description: "This is the header supabase-js .maybeSingle() sends. Tests how PostgREST behaves for the no-rows case under that Accept header.",
            expected: "Either 200 OK with null body, OR 406 Not Acceptable. supabase-js's maybeSingle handles both.",
            status: r.httpStatus === 200 || r.httpStatus === 406 ? "info" : "fail",
            ...r,
        });
    } catch (err) {
        tests.push({
            id: "B",
            title: "Raw GET with Accept: application/vnd.pgrst.object+json",
            description: "supabase-js maybeSingle's Accept header behaviour.",
            expected: "200 or 406",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── C. Raw GET filtered for sentinel (zero rows) with default Accept
    try {
        const r = await rawFetch(
            `${baseUrl}/user_profiles?select=user_id&user_id=eq.${SENTINEL_USER_ID}`,
            { headers: { Accept: "application/json" } },
        );
        tests.push({
            id: "C",
            title: "Raw GET filtered (zero rows expected), Accept: application/json",
            description: "Same query supabase-js would issue, with the simpler Accept header. Confirms 'no row' returns [] not an error.",
            expected: "200 OK with body []",
            status: r.httpStatus === 200 && r.body.trim() === "[]" ? "pass" : "fail",
            ...r,
        });
    } catch (err) {
        tests.push({
            id: "C",
            title: "Raw GET filtered (zero rows)",
            description: "no row returns []",
            expected: "200 OK []",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── D. supabase-js .select().limit(1) — does it work when there ARE rows?
    try {
        const client = createServerSupabase();
        const { data, error } = await client
            .from("user_profiles")
            .select("user_id, email")
            .limit(1);
        tests.push({
            id: "D",
            title: "supabase-js .from().select().limit(1)",
            description: "supabase-js without .maybeSingle(). Tests baseline supabase-js → PostgREST works.",
            expected: "data is an array (possibly []), error is null",
            status: error ? "fail" : "pass",
            body: JSON.stringify({ data, error }, null, 2),
            notes: error
                ? `error keys: ${Object.keys(error).join(",")}, message: ${(error as { message?: string }).message ?? "(undefined)"}`
                : undefined,
        });
    } catch (err) {
        tests.push({
            id: "D",
            title: "supabase-js .select().limit(1)",
            description: "supabase-js baseline.",
            expected: "data array, error null",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── E. supabase-js .maybeSingle() with zero-row filter — the bug we're chasing
    try {
        const client = createServerSupabase();
        const { data, error } = await client
            .from("user_profiles")
            .select("email, display_name")
            .eq("user_id", SENTINEL_USER_ID)
            .maybeSingle();
        const errorEmpty = error && Object.keys(error as object).length === 0;
        tests.push({
            id: "E",
            title: "supabase-js .maybeSingle() with zero matching rows",
            description: "THE BUG: per spec, zero rows should return { data: null, error: null }. We've been seeing { error: {} } truthy-but-empty.",
            expected: "data is null, error is null",
            status: error === null ? "pass" : "fail",
            body: JSON.stringify({ data, error }, null, 2),
            notes: errorEmpty
                ? "error is a truthy empty {} — confirms the supabase-js bug we've been chasing"
                : error
                  ? `error message: ${(error as { message?: string }).message ?? "(undefined)"}`
                  : undefined,
        });
    } catch (err) {
        tests.push({
            id: "E",
            title: "supabase-js .maybeSingle() with zero matching rows",
            description: "THE BUG.",
            expected: "data null, error null",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── F. Raw INSERT roundtrip (insert + verify + delete) with sentinel user
    try {
        // Insert
        const insertResp = await fetch(`${baseUrl}/user_profiles`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Prefer: "return=minimal",
            },
            body: JSON.stringify({
                user_id: SENTINEL_USER_ID,
                email: "diagnostics-sentinel@example.invalid",
                display_name: "Diagnostics Sentinel",
            }),
        });
        const insertBody = await insertResp.text();
        if (!insertResp.ok) {
            tests.push({
                id: "F",
                title: "Raw POST /user_profiles (insert) + DELETE roundtrip",
                description: "Confirms the configured role can INSERT into user_profiles. Inserts a sentinel row, deletes it, reports both.",
                expected: "201 Created with empty body, then 204 No Content on delete",
                status: "fail",
                httpStatus: insertResp.status,
                httpStatusText: insertResp.statusText,
                body: insertBody.slice(0, 500),
                notes: "INSERT failed — likely role grant issue.",
            });
        } else {
            // Delete
            const deleteResp = await fetch(
                `${baseUrl}/user_profiles?user_id=eq.${SENTINEL_USER_ID}`,
                { method: "DELETE", headers: { Prefer: "return=minimal" } },
            );
            tests.push({
                id: "F",
                title: "Raw POST /user_profiles (insert) + DELETE roundtrip",
                description: "Confirms the configured role can INSERT and DELETE.",
                expected: "Insert 201, Delete 204",
                status: deleteResp.ok ? "pass" : "fail",
                httpStatus: deleteResp.status,
                httpStatusText: deleteResp.statusText,
                body: `INSERT: ${insertResp.status} (ok)\nDELETE: ${deleteResp.status} ${deleteResp.statusText}`,
            });
        }
    } catch (err) {
        tests.push({
            id: "F",
            title: "Raw INSERT/DELETE roundtrip",
            description: "Verify INSERT and DELETE permissions on the configured role.",
            expected: "Both succeed",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── G. Schema cache: do the migration-0003/0004 columns exist?
    try {
        const r = await rawFetch(
            `${baseUrl}/user_profiles?select=fast_model,openai_api_key,azure_openai_endpoint&limit=0`,
            { headers: { Accept: "application/json" } },
        );
        tests.push({
            id: "G",
            title: "Schema cache: migration-0003/0004 columns visible",
            description: "Asks PostgREST for columns added by recent migrations. If schema cache is stale, returns 4xx with 'column not found'.",
            expected: "200 OK with body []",
            status: r.httpStatus === 200 ? "pass" : "fail",
            ...r,
        });
    } catch (err) {
        tests.push({
            id: "G",
            title: "Schema cache: new columns visible",
            description: "PostgREST has reloaded after migration.",
            expected: "200 OK",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── H. Configured SUPABASE_URL — sanity-check the env var
    tests.push({
        id: "H",
        title: "Configured SUPABASE_URL",
        description: "What process.env.SUPABASE_URL points at. supabase-js v2 always appends /rest/v1 to this. If our PostgREST serves tables at root (like the internal Container App PostgREST), supabase-js's URL won't match.",
        expected: "URL the supabase-js client uses as its base",
        status: "info",
        body: baseUrl || "(unset)",
    });

    // ── I. Raw GET to the URL supabase-js *would* hit (with /rest/v1 prefix)
    // This is the smoking gun: if this fails, supabase-js's prepended
    // /rest/v1 is the reason its calls fail.  After the wrapper fix lands,
    // the wrapper rewrites the path so supabase-js calls succeed; this raw
    // test will continue to fail because nobody rewrites it.
    try {
        const r = await rawFetch(
            `${baseUrl}/rest/v1/user_profiles?select=user_id&limit=1`,
            { headers: { Accept: "application/json" } },
        );
        tests.push({
            id: "I",
            title: "Raw GET /rest/v1/user_profiles (the URL supabase-js builds)",
            description: "supabase-js hardcodes ${SUPABASE_URL}/rest/v1 as the REST base. If our PostgREST doesn't have that prefix, this fails — and so does every supabase-js call.",
            expected: "If this fails (4xx/5xx) and Test A passes, the /rest/v1 mismatch is the bug",
            status: r.httpStatus === 200 ? "info" : "fail",
            ...r,
            notes:
                r.httpStatus !== 200
                    ? "Confirms supabase-js's /rest/v1 prefix has no matching route on this PostgREST. Fix: fetch wrapper strips /rest/v1 before forwarding."
                    : undefined,
        });
    } catch (err) {
        tests.push({
            id: "I",
            title: "Raw GET /rest/v1/user_profiles",
            description: "URL supabase-js builds.",
            expected: "200 if /rest/v1 is served, 4xx if not",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── J. config.ts → KV live read (issue 023 slice 1)
    // Probe a KV secret through getConfig() to verify the foundation:
    //   - KEY_VAULT_NAME env var is set
    //   - DefaultAzureCredential resolves the UAMI (AZURE_CLIENT_ID)
    //   - UAMI has Key Vault Secrets User on this vault
    //   - getConfig's env→cache→KV chain is wired up
    // Probes `postgrest-jwt-secret` because it's known to exist in KV AND
    // is NOT mapped to a Container App env var, so the env-override
    // shortcut doesn't fire and we actually exercise the KV path. Only
    // the value's length is reported, never the value.
    try {
        flushConfigCache();
        const t0 = Date.now();
        const value = await getConfig("postgrest-jwt-secret");
        const live = Date.now() - t0;
        const t1 = Date.now();
        await getConfig("postgrest-jwt-secret");
        const cached = Date.now() - t1;
        tests.push({
            id: "J",
            title: "config.ts: live KV read + cache hit",
            description: "Calls getConfig('postgrest-jwt-secret') from the install-flow config foundation. First call goes to KV; second hits the in-process cache.",
            expected: "Both calls return a value; cached call is materially faster than live.",
            status: value ? "pass" : "fail",
            body: `live=${live}ms, cached=${cached}ms, value.length=${value.length}, KEY_VAULT_NAME=${process.env.KEY_VAULT_NAME ?? "(unset)"}`,
            notes: !value
                ? "Empty value — secret exists but holds no data."
                : cached >= live
                  ? "Cached call wasn't faster — cache may not be wired correctly."
                  : undefined,
        });
    } catch (err) {
        tests.push({
            id: "J",
            title: "config.ts: live KV read + cache hit",
            description: "Calls getConfig('postgrest-jwt-secret') from the install-flow config foundation.",
            expected: "Returns the secret value via KEY_VAULT_NAME + UAMI + cache.",
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
            notes: `KEY_VAULT_NAME=${process.env.KEY_VAULT_NAME ?? "(unset)"} — most likely cause: env var missing or UAMI lacks Key Vault Secrets User.`,
        });
    }

    return tests;
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

    let rows: Record<string, unknown>[] | null = null;
    let queryError: string | null = null;
    try {
        const db = createServerSupabase();
        let q = db.from(table).select("*").limit(limit);
        for (const [k, v] of Object.entries(filter)) {
            q = q.eq(k, v as never);
        }
        const { data, error } = await q;
        if (error) {
            queryError = `${error.message}${error.code ? ` (code=${error.code})` : ""}${error.details ? ` — ${error.details}` : ""}`;
        } else {
            rows = (data ?? []) as Record<string, unknown>[];
        }
    } catch (err) {
        queryError = err instanceof Error ? err.message : String(err);
    }

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
