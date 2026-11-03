// Multi-tenant issue 003: a claimed job runs as the tenant that queued it.
// Uses the real supabase-js client against a stubbed fetch, so the assertion
// is on what PostgREST would receive (the JWT tenant claim) and on the
// db.no_tenant_context counter staying at zero for job execution.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage", () => ({ deleteFile: vi.fn() }));

import { processClaimedJob, runDbJobTick } from "../runner";
import type { DbJob } from "../types";
import { createPlatformSupabase, createServerSupabase, resetPostgrestJwtState } from "../../supabase";
import {
  currentTenant,
  noTenantContextCounts,
  resetNoTenantContextCounts,
  resetTenantConfigCache,
} from "../../tenantContext";

const SECRET = "a-test-postgrest-secret-of-at-least-32-chars";
const TOUCHED_ENV = ["AUTH_PROVIDER", "SUPABASE_URL", "POSTGREST_JWT_SECRET", "ENTRA_TENANT_ID", "DEFAULT_TENANT_ID", "KEY_VAULT_NAME"] as const;
const saved: Record<string, string | undefined> = {};
let requests: Array<{ path: string; tenant: unknown; role: unknown; actor: unknown; body: unknown }> = [];
let claimRows: DbJob[] = [];

function job(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: crypto.randomUUID(), kind: "test.kind", payload: {}, status: "running", attempts: 1, max_attempts: 3,
    run_at: new Date().toISOString(), claimed_at: null, claim_token: crypto.randomUUID(), lease_expires_at: null,
    finished_at: null, last_error: null, dedupe_key: null, result: null, created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env.AUTH_PROVIDER = "entra";
  process.env.POSTGREST_JWT_SECRET = SECRET;
  process.env.ENTRA_TENANT_ID = "install-tid";
  process.env.SUPABASE_URL = `http://${crypto.randomUUID()}.postgrest.test`;
  resetPostgrestJwtState();
  resetTenantConfigCache();
  resetNoTenantContextCounts();
  requests = [];
  claimRows = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization")?.slice(7) ?? "";
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}");
    const path = new URL(input).pathname;
    requests.push({ path, tenant: claims.tenant_id, role: claims.role, actor: claims.sub, body: init.body ? JSON.parse(Buffer.from(init.body as ArrayBuffer).toString()) : null });
    const body = path === "/rpc/claim_db_jobs" ? claimRows : path.startsWith("/rpc/") ? true : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("job tenant context", () => {
  // Issue 008: the outcome write is job control (service_role only), so it
  // goes through the platform client while the handler runs as the tenant.
  it("the handler and its queries run as the job's tenant; the outcome write as the platform", async () => {
    let seen: unknown;
    const handler = vi.fn(async (db: ReturnType<typeof createServerSupabase>) => {
      seen = currentTenant();
      await db.from("documents").select("id");
    });
    const db = createServerSupabase();
    await processClaimedJob(db, { "test.kind": handler }, job({ tenant_id: "tenant-a" }), {}, createPlatformSupabase());

    expect(seen).toEqual({ tenantId: "tenant-a" });
    expect(requests.map((r) => [r.path, r.tenant, r.role])).toEqual([
      ["/documents", "tenant-a", "tenant_app"],
      ["/rpc/finish_db_job", undefined, "service_role"],
    ]);
    expect(noTenantContextCounts().size).toBe(0);
    expect(currentTenant()).toBeUndefined();
  });

  it("preserves the actor in a trusted durable job for per-user credit caps", async () => {
    let seen: unknown;
    await processClaimedJob(createServerSupabase(), {
      "test.kind": async (db) => { seen = currentTenant(); await db.from("documents").select("id"); },
    }, job({ tenant_id: "tenant-a", payload: { userId: "job-user" } }), {}, createPlatformSupabase());
    expect(seen).toEqual({ tenantId: "tenant-a", userId: "job-user" });
    expect(requests.find((request) => request.path === "/documents")?.actor).toBe("job-user");
    expect(requests.find((request) => request.path === "/rpc/finish_db_job")?.actor).toBeUndefined();
  });

  it("uses the durable memory actor for asynchronous curation", async () => {
    let seen: unknown;
    await processClaimedJob(createServerSupabase(), {
      "memory.consolidate": async () => { seen = currentTenant(); },
    }, job({ kind: "memory.consolidate", tenant_id: "tenant-a", payload: { actorUserId: "memory-user" } }), {}, createPlatformSupabase());
    expect(seen).toEqual({ tenantId: "tenant-a", userId: "memory-user" });
  });

  it("a row without tenant_id (pre-0179 or platform-queued) runs as the install tenant", async () => {
    let seen: unknown;
    await processClaimedJob(createServerSupabase(), {
      "test.kind": async () => { seen = currentTenant()?.tenantId; },
    }, job({ tenant_id: null }));
    expect(seen).toBe("install-tid");
    expect(noTenantContextCounts().size).toBe(0);
  });

  it("the failure hook also runs as the job's tenant", async () => {
    let hookTenant: unknown;
    await processClaimedJob(
      createServerSupabase(),
      { "test.kind": async () => { throw new Error("boom"); } },
      job({ tenant_id: "tenant-b", attempts: 3, max_attempts: 3 }),
      { "test.kind": async () => { hookTenant = currentTenant()?.tenantId; } },
    );
    expect(hookTenant).toBe("tenant-b");
  });

  it("a tick claims through the platform client and runs each job as its own tenant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    claimRows = [job({ tenant_id: "tenant-a" }), job({ tenant_id: "tenant-b" })];
    const seen: unknown[] = [];
    const ran = await runDbJobTick(
      createServerSupabase(),
      { "test.kind": async () => { seen.push(currentTenant()?.tenantId); } },
      {},
      undefined,
      createPlatformSupabase(),
    );
    expect(ran).toBe(2);
    expect(seen.sort()).toEqual(["tenant-a", "tenant-b"]);
    const claim = requests.find((r) => r.path === "/rpc/claim_db_jobs");
    expect(claim?.tenant).toBeUndefined();
    expect(requests.filter((r) => r.path === "/rpc/finish_db_job").map((r) => r.role)).toEqual(["service_role", "service_role"]);
    expect(noTenantContextCounts().size).toBe(0);
  });
});
