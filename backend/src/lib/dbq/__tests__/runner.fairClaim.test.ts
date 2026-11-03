// Multi-tenant 017: claim_db_jobs (0184) picks round-robin across tenants and
// takes an optional per-tenant concurrency cap. The runner passes the cap only
// when DBQ_TENANT_CONCURRENCY is set, so single-tenant installs send the same
// RPC arguments as before. (The SQL itself is validated against Postgres; see
// the issue's As built section.)
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../supabase", () => ({ createServerSupabase: vi.fn(), createPlatformSupabase: vi.fn() }));
vi.mock("../../storage", () => ({ deleteFile: vi.fn() }));

import { runDbJobTick, tenantConcurrencyCap } from "../runner";
import type { Db } from "../types";

afterEach(() => vi.unstubAllEnvs());

function claimDb() {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const db = {
    rpc: async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: [], error: null };
    },
  } as unknown as Db;
  return { db, calls };
}

describe("fair job claiming", () => {
  it("parses DBQ_TENANT_CONCURRENCY; unset, zero or junk means no cap", () => {
    expect(tenantConcurrencyCap({})).toBeUndefined();
    expect(tenantConcurrencyCap({ DBQ_TENANT_CONCURRENCY: "0" })).toBeUndefined();
    expect(tenantConcurrencyCap({ DBQ_TENANT_CONCURRENCY: "x" })).toBeUndefined();
    expect(tenantConcurrencyCap({ DBQ_TENANT_CONCURRENCY: "3" })).toBe(3);
  });

  it("claims with the pre-017 arguments when no cap is configured", async () => {
    const { db, calls } = claimDb();
    await runDbJobTick(db, {});
    expect(calls).toEqual([{ name: "claim_db_jobs", args: { p_limit: 5, p_stale_seconds: 600 } }]);
  });

  it("passes the per-tenant cap when configured", async () => {
    vi.stubEnv("DBQ_TENANT_CONCURRENCY", "2");
    const { db, calls } = claimDb();
    await runDbJobTick(db, {});
    expect(calls[0]).toEqual({
      name: "claim_db_jobs",
      args: { p_limit: 5, p_stale_seconds: 600, p_tenant_cap: 2 },
    });
  });
});
