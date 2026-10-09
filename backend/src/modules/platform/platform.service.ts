// PostgREST diagnostics data access. Route files only authenticate and render.
import { createServerSupabase } from "../../lib/supabase";
import { getConfig, flushConfigCache } from "../../lib/config";

const SENTINEL_USER_ID = "00000000-0000-0000-0000-dddd0000dddd";

export type TestResult = {
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

export async function runDiagnostics(): Promise<TestResult[]> {
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

    // ── G. Schema cache: do the migration-0006 columns exist?
    //
    // Updated from migrations 0003/0004 columns (which the
    // ba6f771 sync is in the process of retiring — see
    // UPSTREAM_SYNC_LOG.md and 0007_drop_legacy_provider_keys.sql,
    // pending). The user_api_keys table is what newly-deployed
    // schemas must have to function.
    try {
        const r = await rawFetch(
            `${baseUrl}/user_api_keys?select=provider,encrypted_key&limit=0`,
            { headers: { Accept: "application/json" } },
        );
        tests.push({
            id: "G",
            title: "Schema cache: migration-0006 user_api_keys columns visible",
            description: "Asks PostgREST for columns on user_api_keys. If schema cache is stale, returns 4xx with 'relation/column not found'.",
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

    // ── J. config.ts → KV live read
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


export async function inspectRows(table:string, filter:Record<string,unknown>, limit:number): Promise<{rows:Record<string,unknown>[]|null; queryError:string|null}> {
  try {
    const db=createServerSupabase();
    let q=db.from(table).select("*").limit(limit);
    for(const [key,value] of Object.entries(filter)) q=q.eq(key,value as never);
    const {data,error}=await q;
    return error ? {rows:null,queryError:`${error.message}${error.code?` (code=${error.code})`:""}${error.details?` — ${error.details}`:""}`} : {rows:(data??[]) as Record<string,unknown>[],queryError:null};
  } catch(error) { return {rows:null,queryError:error instanceof Error?error.message:String(error)}; }
}
