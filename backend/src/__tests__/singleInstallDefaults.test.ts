import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// A normal install (Marketplace, desktop, local) is one single system and
// must need none of the pooled multi-tenant setup: no TENANCY_MODE, Key Vault
// tenancy secret, control plane, stamp identity, credit prices or tenant-admin
// configuration. Any database client reached by the paths below is a bug.
const mocks = vi.hoisted(() => ({ dbCalls: [] as string[] }));
vi.mock("../lib/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/supabase")>();
  const tripwire = (name: string) => () => {
    mocks.dbCalls.push(name);
    throw new Error(`${name} must not be reached in single mode`);
  };
  return {
    ...actual,
    createServerSupabase: tripwire("createServerSupabase"),
    createPlatformSupabase: tripwire("createPlatformSupabase"),
  };
});

// The tenant role probe is a real database call by design; its own suite covers
// it, and this file's tripwires guard the paths below against any other call.
vi.mock("../lib/tenantDatabaseProbe", () => ({ probeTenantPostgrestPath: vi.fn(async () => {}) }));

import { buildApp } from "../app";
import type { Db } from "../lib/supabase";
import { readStampConfiguration } from "../lib/stampConfiguration";
import { probeStampRuntime, type StampRuntimeMetadata } from "../lib/stampRuntime";
import { getTenancyMode, resetFrozenTenancyModeForTests } from "../lib/tenancyMode";
import { reserveTenantCredits } from "../lib/tenantCredits";
import { runWithTenant } from "../lib/tenantContext";
import type { LlmCallDescriptor } from "../lib/llm/usage";
import { tenantAdminOverview, tenantAdminStatus } from "../modules/tenant-admin/tenant-admin.service";

const CLEARED_ENV = [
  "TENANCY_MODE", "KEY_VAULT_NAME", "CONTROL_PLANE_URL", "STAMP_ID", "STAMP_REGION",
  "DEFAULT_TENANT_ID", "POOLED_ONBOARDING_URL", "TENANT_RLS_ENFORCED",
] as const;
const TOUCHED_ENV = [...CLEARED_ENV, "AUTH_PROVIDER"] as const;
let saved: Record<string, string | undefined>;

const PLATFORM_CALL: LlmCallDescriptor = {
  model: "gpt-6-luna", provider: "openai", feature: "chat", keyMode: "platform",
};

/** What the migration runner writes for a single install, before and after first-tenant adoption. */
function freshSingleMetadata(fallback: string | null): StampRuntimeMetadata {
  return { pooled: false, fallback_tenant_id: fallback, stamp_id: null, region: null, platform_credentials: [] };
}
const metadataDb = (metadata: StampRuntimeMetadata) =>
  ({ rpc: vi.fn(async () => ({ data: metadata, error: null })) }) as unknown as Db & { rpc: ReturnType<typeof vi.fn> };

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));
  for (const key of CLEARED_ENV) delete process.env[key];
  process.env.AUTH_PROVIDER = "local";
  resetFrozenTenancyModeForTests();
  mocks.dbCalls = [];
});
afterEach(() => {
  resetFrozenTenancyModeForTests();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("single install defaults", () => {
  it("reads a single-install stamp configuration with no tenancy, stamp or tenant settings", async () => {
    expect(await readStampConfiguration()).toMatchObject({
      mode: "single", provider: "local", fallbackTenantId: "default",
      stampId: undefined, region: undefined,
    });
  });

  it.each([null, "default"])("passes the startup probe on the runner's single metadata (fallback %s) and freezes single", async (fallback) => {
    const db = metadataDb(freshSingleMetadata(fallback));
    await expect(probeStampRuntime(db)).resolves.toMatchObject({ pooled: false });
    expect(db.rpc).toHaveBeenCalledWith("stamp_runtime_metadata");
    process.env.TENANCY_MODE = "pooled";
    expect(await getTenancyMode()).toBe("single");
  });

  it("refuses to serve a pooled database as a single install", async () => {
    const db = metadataDb({ ...freshSingleMetadata(null), pooled: true });
    await expect(probeStampRuntime(db)).rejects.toThrow("tenancy mode does not match");
  });

  it("admits platform-key model calls without credit prices, budgets or any database call", async () => {
    expect(await reserveTenantCredits(PLATFORM_CALL, "Hello")).toBeUndefined();
    expect(await runWithTenant({ tenantId: "default", userId: "user-1" },
      () => reserveTenantCredits(PLATFORM_CALL, "Hello"))).toBeUndefined();
    expect(mocks.dbCalls).toEqual([]);
  });

  it("keeps tenant administration inert, even for a caller carrying a TenantAdmin role", async () => {
    const db = { from: vi.fn(), rpc: vi.fn() };
    await runWithTenant({ tenantId: "default", userId: "user-1", roles: ["TenantAdmin"] }, async () => {
      expect(tenantAdminStatus()).toEqual({ isTenantAdmin: false });
      expect(await tenantAdminOverview(db as unknown as Db)).toMatchObject({ ok: false });
    });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("serves runtime config as single, with no control-plane or onboarding URL", async () => {
    const response = await request(buildApp()).get("/config");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authProvider: "local", tenancyMode: "single", controlPlaneUrl: null });
    expect(response.body).not.toHaveProperty("onboardingUrl");
  });

  it("serves the /install surface (pooled-only 404 does not apply)", async () => {
    const response = await request(buildApp()).get("/install");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });
});
