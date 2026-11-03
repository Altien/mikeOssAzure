// Multi-tenant issues 002 and 008: every PostgREST request carries the current tenant
// in a short-lived HS256 JWT minted by the fetch wrapper in lib/supabase.ts.
// These tests drive the real supabase-js client against a stubbed global
// fetch and decode what would have gone over the wire.

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformSupabase,
  createServerSupabase,
  resetPostgrestJwtState,
  postgrestClaims,
} from "../supabase";
import {
  noTenantContextCounts,
  resetNoTenantContextCounts,
  resetTenantConfigCache,
  runWithTenant,
} from "../tenantContext";

const SECRET = "a-test-postgrest-secret-of-at-least-32-chars";
const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "POSTGREST_JWT_SECRET",
  "JWT_SECRET",
  "KEY_VAULT_NAME",
  "TENANT_RLS_ENFORCED",
  "ENTRA_TENANT_ID",
  "DEFAULT_TENANT_ID",
] as const;
const saved: Record<string, string | undefined> = {};

type Captured = { url: string; method: string; headers: Headers; body: string | null };
let captured: Captured[] = [];
let responder: (index: number) => Response = () => json([]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
  for (const key of TOUCHED_ENV) delete process.env[key];
  // A fresh URL per test defeats the client cache.
  process.env.SUPABASE_URL = `http://${crypto.randomUUID()}.postgrest.test`;
  resetPostgrestJwtState();
  resetNoTenantContextCounts();
  resetTenantConfigCache();
  captured = [];
  responder = () => json([]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const body = init.body ? Buffer.from(init.body as ArrayBuffer).toString("utf8") : null;
    captured.push({ url: input, method: init.method ?? "GET", headers: new Headers(init.headers), body });
    return responder(captured.length - 1);
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function bearer(index = 0): string | null {
  const header = captured[index]?.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function decodeVerified(token: string, secret = SECRET): Record<string, unknown> {
  const [header, payload, signature] = token.split(".");
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  expect(signature).toBe(expected);
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

describe("entra mode", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.POSTGREST_JWT_SECRET = SECRET;
  });

  it("sends the request's tenant and user in a signed 60 s tenant_app JWT", async () => {
    await runWithTenant({ tenantId: "tenant-a", userId: "user-a" }, async () => {
      const { error } = await createServerSupabase().from("chats").select("id");
      expect(error).toBeNull();
    });
    expect(new URL(captured[0].url).pathname).toBe("/chats");
    expect(captured[0].headers.get("apikey")).toBeNull();
    const claims = decodeVerified(bearer()!);
    expect(claims).toMatchObject({ role: "tenant_app", tenant_id: "tenant-a", sub: "user-a" });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);
    expect(noTenantContextCounts().size).toBe(0);
  });

  it("concurrent requests each carry their own tenant", async () => {
    await Promise.all(["t1", "t2", "t3"].map((tenantId) =>
      runWithTenant({ tenantId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, tenantId === "t1" ? 5 : 1));
        await createServerSupabase().rpc("whoami", { p_tag: tenantId });
      }),
    ));
    const pairs = captured.map((call, index) => [JSON.parse(call.body!).p_tag, decodeVerified(bearer(index)!).tenant_id]);
    for (const [tag, tenant] of pairs) expect(tenant).toBe(tag);
  });

  // Issue 008: no install tenant (pooled) → no claim, so RLS shows no rows.
  it("a call outside any tenant scope with no install tenant runs as tenant_app with no tenant claim and is counted", async () => {
    await createServerSupabase().from("auth_sessions").select("session_hash");
    const claims = decodeVerified(bearer()!);
    expect(claims.role).toBe("tenant_app");
    expect(claims).not.toHaveProperty("tenant_id");
    expect(claims).not.toHaveProperty("sub");
    const keys = [...noTenantContextCounts().keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/ GET \/auth_sessions$/);
  });

  // Issue 008: a single-tenant install runs the call as its one tenant, so
  // behaviour is unchanged; the gap is still counted.
  it("a call outside any tenant scope runs as the install tenant when there is one", async () => {
    process.env.ENTRA_TENANT_ID = "install-tid";
    await createServerSupabase().from("chats").select("id");
    const claims = decodeVerified(bearer()!);
    expect(claims).toMatchObject({ role: "tenant_app", tenant_id: "install-tid" });
    expect(claims).not.toHaveProperty("sub");
    expect(noTenantContextCounts().size).toBe(1);
  });

  it("the platform client never sends a tenant and never counts as a gap", async () => {
    await runWithTenant({ tenantId: "tenant-a", userId: "user-a" }, async () => {
      await createPlatformSupabase().rpc("claim_db_jobs", { p_limit: 1 });
    });
    await createPlatformSupabase().from("tenants").select("tenant_id");
    for (const index of [0, 1]) {
      const claims = decodeVerified(bearer(index)!);
      expect(claims.role).toBe("service_role");
      expect(claims).not.toHaveProperty("tenant_id");
      expect(claims).not.toHaveProperty("sub");
    }
    expect(noTenantContextCounts().size).toBe(0);
    expect(createPlatformSupabase()).not.toBe(createServerSupabase());
  });

  // Issue 008: no unsigned fallback any more.
  it("without a signing secret fails before anything is sent", async () => {
    delete process.env.POSTGREST_JWT_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { error } = await runWithTenant({ tenantId: "tenant-a" }, async () => await createServerSupabase().from("chats").select("id"));
    expect(error?.code).toBe("POSTGREST_JWT_UNAVAILABLE");
    expect(captured).toHaveLength(0);
  });

  it("a rejected JWT is returned as the error, not retried unsigned", async () => {
    responder = () => json({ code: "PGRST301", message: "JWSError" }, 401);
    const { error } = await runWithTenant({ tenantId: "tenant-a" }, async () =>
      await createServerSupabase().from("chats").insert({ title: "hello" }).select("id").single());
    expect(error?.code).toBe("PGRST301");
    expect(captured).toHaveLength(1);
    expect(bearer(0)).not.toBeNull();
  });

  it("tenant-rls-enforced=false sends service_role on the request client (rollback switch)", async () => {
    process.env.TENANT_RLS_ENFORCED = "false";
    await runWithTenant({ tenantId: "tenant-a" }, async () => await createServerSupabase().from("chats").select("id"));
    expect(decodeVerified(bearer()!)).toMatchObject({ role: "service_role", tenant_id: "tenant-a" });
  });

  it("ordinary 401/403/500 errors are not retried", async () => {
    responder = () => json({ code: "42501", message: "permission denied" }, 401);
    await runWithTenant({ tenantId: "t" }, async () => await createServerSupabase().from("chats").select("id"));
    expect(captured).toHaveLength(1);
  });

  // A query builder is lazy: it runs where it is awaited. One returned
  // un-awaited from a scope executes outside it (documented in tenantContext).
  it("a builder awaited outside the scope runs without the tenant", async () => {
    await runWithTenant({ tenantId: "t" }, () => createServerSupabase().from("chats").select("id"));
    expect(decodeVerified(bearer()!)).not.toHaveProperty("tenant_id");
    expect(noTenantContextCounts().size).toBe(1);
  });
});

// Issue 004: the gap hunt's throw-on-missing-context switch.
describe("TENANT_CONTEXT_STRICT", () => {
  const nodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.POSTGREST_JWT_SECRET = SECRET;
    process.env.TENANT_CONTEXT_STRICT = "true";
  });
  afterEach(() => {
    delete process.env.TENANT_CONTEXT_STRICT;
    process.env.NODE_ENV = nodeEnv;
  });

  it("fails a tenant-scoped call made without a context, before it is sent", async () => {
    const { error } = await createServerSupabase().from("chats").select("id");
    expect(error?.message).toMatch(/without a tenant context: GET \/chats/);
    expect(captured).toHaveLength(0);
  });

  it("lets tenant-scoped and platform calls through", async () => {
    const scoped = await runWithTenant({ tenantId: "t" }, async () => await createServerSupabase().from("chats").select("id"));
    const platform = await createPlatformSupabase().from("tenants").select("tenant_id");
    expect(scoped.error).toBeNull();
    expect(platform.error).toBeNull();
    expect(captured).toHaveLength(2);
  });

  it("is ignored in production", async () => {
    process.env.NODE_ENV = "production";
    const { error } = await createServerSupabase().from("chats").select("id");
    expect(error).toBeNull();
    expect(noTenantContextCounts().size).toBe(1);
  });
});

describe("local mode", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "local";
    process.env.SUPABASE_SECRET_KEY = "static-service-role-jwt";
  });

  it("signs with JWT_SECRET (the stack's PGRST_JWT_SECRET)", async () => {
    process.env.JWT_SECRET = SECRET;
    await runWithTenant({ tenantId: "default", userId: "u" }, async () => await createServerSupabase().from("chats").select("id"));
    expect(decodeVerified(bearer()!)).toMatchObject({ tenant_id: "default", sub: "u", role: "tenant_app" });
  });

  it("runs a call outside any tenant scope as the default tenant", async () => {
    process.env.JWT_SECRET = SECRET;
    await createServerSupabase().from("chats").select("id");
    expect(decodeVerified(bearer()!)).toMatchObject({ role: "tenant_app", tenant_id: "default" });
  });

  it("never sends the static service-role key, even without a usable secret", async () => {
    process.env.JWT_SECRET = "too-short";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { error } = await runWithTenant({ tenantId: "default" }, async () => await createServerSupabase().from("chats").select("id"));
    expect(error?.code).toBe("POSTGREST_JWT_UNAVAILABLE");
    expect(captured).toHaveLength(0);
  });
});

it("signs only the admitted pooled context roles and never borrows them for a job", () => {
  expect(postgrestClaims({ tenantId: "tenant", userId: "admin", pooled: true, roles: ["TenantAdmin", "Member"] }, "tenant_app"))
    .toMatchObject({ tenant_id: "tenant", sub: "admin", app_roles: ["TenantAdmin", "Member"] });
  expect(postgrestClaims({ tenantId: "tenant", userId: "worker" }, "tenant_app")).not.toHaveProperty("app_roles");
});
