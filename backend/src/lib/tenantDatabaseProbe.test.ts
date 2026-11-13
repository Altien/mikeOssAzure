// The startup proof that tenant traffic can use its database role. Runs the real
// signing client against a fake PostgREST, so role and claims are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPostgrestJwtState } from "./supabase";
import { resetFrozenTenancyModeForTests } from "./tenancyMode";
import { resetTenantConfigCache } from "./tenantContext";
import { checkTenantPostgrestPath, probeTenantPostgrestPath, tableGrantGuidance, TENANT_PROBE_ID } from "./tenantDatabaseProbe";

const SECRET = "a-test-postgrest-secret-of-at-least-32-chars";
const ROLE_DENIED = {
  code: "42501",
  message: "permission denied to set role with raw text postgres://login:hunter2@db/mike",
};

type Seen = { url: string; method: string; authorization: string };
let seen: Seen[];
let answer: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** postgrest-js waits 1, 2 and 4 s before retrying a 503 or a thrown GET. Only that clock is faked. */
async function withoutRetryDelays<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const pending = run().finally(() => { settled = true; });
    while (!settled) await vi.advanceTimersByTimeAsync(1_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function claims(call: Seen): Record<string, unknown> {
  const payload = call.authorization.replace("Bearer ", "").split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

beforeEach(() => {
  seen = [];
  answer = () => json(200, []);
  vi.stubEnv("AUTH_PROVIDER", "local");
  vi.stubEnv("JWT_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "http://postgrest.test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "unused-by-the-signing-wrapper");
  vi.stubEnv("KEY_VAULT_NAME", "");
  vi.stubEnv("TENANCY_MODE", "");
  vi.stubEnv("TENANT_RLS_ENFORCED", "");
  vi.stubEnv("DEFAULT_TENANT_ID", "");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization") ?? "" });
    return answer();
  }));
  resetFrozenTenancyModeForTests();
  resetPostgrestJwtState();
  resetTenantConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetFrozenTenancyModeForTests();
  resetPostgrestJwtState();
  resetTenantConfigCache();
});

describe("probeTenantPostgrestPath", () => {
  it("passes an empty install: one signed GET as tenant_app, with the install's tenant", async () => {
    await expect(probeTenantPostgrestPath()).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toContain("/tenants?select=tenant_id&limit=1");
    expect(claims(seen[0])).toMatchObject({ role: "tenant_app", tenant_id: "default" });
  });

  it("fails on a denied role, naming the role, the code and what to do", async () => {
    answer = () => json(403, ROLE_DENIED);
    const error = await probeTenantPostgrestPath().catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("role tenant_app");
    expect(error.message).toContain("code 42501");
    expect(error.message).toContain("HTTP 403");
    expect(error.message).toContain("GRANT tenant_app TO <login>");
    expect(error.message).toContain("tenant-rls-enforced=false");
  });

  it("says a 42501 may be the login or the table, and how to tell, because it only has the code", async () => {
    answer = () => json(403, ROLE_DENIED);
    const error = await probeTenantPostgrestPath().catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("Either the PostgREST login lacks role tenant_app, or that role lacks a grant on public.tenants");
    expect(error.message).toContain("cannot tell which");
    expect(error.message).toContain("pg_has_role('<login>', 'tenant_app', 'member')");
    expect(error.message).toContain("run the migration job");
    expect(error.message).toContain("If it applies nothing");
    expect(error.message).toContain("GRANT SELECT, INSERT ON public.tenants TO tenant_app.");
  });

  it.each([
    ["tenant_app", "public.stream_runs", "GRANT SELECT, INSERT, UPDATE, DELETE ON public.stream_runs TO tenant_app."],
    ["service_role", "public.stream_runs", "GRANT SELECT, INSERT, UPDATE, DELETE ON public.stream_runs TO service_role."],
    ["tenant_app", "public.tenants", "GRANT SELECT, INSERT ON public.tenants TO tenant_app."],
    ["service_role", "public.tenants", "GRANT ALL ON public.tenants TO service_role."],
    ["service_role", "public.pgmigrations", "GRANT SELECT ON public.pgmigrations TO service_role."],
  ])("tells %s on %s to run the job first, then the re-grant that matches the migrations", (role, table, statement) => {
    const advice = tableGrantGuidance(role, table);
    expect(advice).toContain(`Role ${role} lacks a grant on ${table}`);
    expect(advice.indexOf("run the migration job")).toBeLessThan(advice.indexOf("GRANT"));
    expect(advice).toContain("If it applies nothing");
    expect(advice).toContain(statement);
  });

  it("never carries the raw message or the signed token", async () => {
    answer = () => json(403, ROLE_DENIED);
    const error = await probeTenantPostgrestPath().catch((caught: Error) => caught) as Error;
    const token = seen[0].authorization.replace("Bearer ", "");
    expect(token.length).toBeGreaterThan(20);
    for (const text of [error.message, error.stack ?? "", JSON.stringify(error)]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain(SECRET);
    }
    expect(error.cause).toBeUndefined();
  });

  it("drops a code that does not look like one", async () => {
    answer = () => json(500, { code: "not a code: secret=hunter2", message: "x" });
    const error = await probeTenantPostgrestPath().catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("code no code");
    expect(error.message).not.toContain("hunter2");
  });

  it.each([
    [401, { code: "PGRST301", message: "JWSError" }, "PGRST_JWT_SECRET"],
    [401, { code: "PGRST302", message: "anon" }, "PGRST_JWT_SECRET"],
    [503, { code: "PGRST002", message: "schema cache" }, "running and reachable"],
    [500, { code: "XX000", message: "internal" }, "running and reachable"],
    [400, { code: "22023", message: "role does not exist" }, "migration job"],
  ])("gives advice for the cause, and no grant or rollback, on HTTP %i %j", async (status, body, advice) => {
    answer = () => json(status, body);
    const error = await withoutRetryDelays(() => probeTenantPostgrestPath().catch((caught: Error) => caught)) as Error;
    expect(error.message).toContain(`code ${body.code}`);
    expect(error.message).toContain(advice);
    expect(error.message).not.toContain("tenant-rls-enforced");
    expect(error.message).not.toContain("GRANT");
  });

  it("gives no grant or rollback advice when PostgREST cannot be reached", async () => {
    answer = () => { throw new TypeError("fetch failed"); };
    const error = await withoutRetryDelays(() => probeTenantPostgrestPath().catch((caught: Error) => caught)) as Error;
    expect(error.message).toContain("running and reachable");
    expect(error.message).not.toContain("tenant-rls-enforced");
    expect(error.message).not.toContain("GRANT");
  });

  it("does not require tenant_app under the rollback switch", async () => {
    vi.stubEnv("TENANT_RLS_ENFORCED", "false");
    await expect(probeTenantPostgrestPath()).resolves.toBeUndefined();
    expect(claims(seen[0]).role).toBe("service_role");
  });

  it("does not suggest the rollback switch when the rollback role itself fails", async () => {
    vi.stubEnv("TENANT_RLS_ENFORCED", "false");
    answer = () => json(403, ROLE_DENIED);
    const error = await probeTenantPostgrestPath().catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("role service_role");
    expect(error.message).not.toContain("tenant-rls-enforced");
  });

  it("uses a reserved claim on a pooled stamp and does not suggest the rollback there", async () => {
    vi.stubEnv("TENANCY_MODE", "pooled");
    await expect(probeTenantPostgrestPath()).resolves.toBeUndefined();
    expect(claims(seen[0])).toMatchObject({ role: "tenant_app", tenant_id: TENANT_PROBE_ID });

    answer = () => json(403, ROLE_DENIED);
    const error = await probeTenantPostgrestPath().catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("GRANT tenant_app TO <login>");
    expect(error.message).not.toContain("tenant-rls-enforced");
  });

  it("is not applicable on hosted Supabase, which does not use the signing path", async () => {
    vi.stubEnv("AUTH_PROVIDER", "supabase");
    expect(await checkTenantPostgrestPath()).toEqual({ state: "skipped" });
    expect(seen).toEqual([]);
  });
});
