// Multi-tenant issue 003: StreamRunCluster's raw pg connections carry the same
// request.jwt.claims as PostgREST traffic, so stream_runs.tenant_id defaults
// to the caller's tenant (migration 0179). A fake `pg` records the SQL.

import { afterEach, describe, expect, it, vi } from "vitest";

const { queries } = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params?: unknown[] }> }));

vi.mock("pg", () => {
  class FakeClient {
    async connect() {}
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    on() { return this; }
    release() {}
    async end() {}
  }
  class FakePool {
    async connect() { return new FakeClient(); }
    async end() {}
  }
  return { Client: FakeClient, Pool: FakePool, default: { Client: FakeClient, Pool: FakePool } };
});

import { StreamRunCluster } from "../streamRunCluster";
import { currentTenant, runWithTenant } from "../tenantContext";

let cluster: StreamRunCluster | null = null;
afterEach(async () => {
  await cluster?.close();
  cluster = null;
  queries.length = 0;
});

function claimsSetBefore(marker: string): Record<string, unknown> {
  const index = queries.findIndex((q) => q.sql === marker);
  const setConfig = queries.slice(0, index).reverse().find((q) => q.sql.includes("set_config('request.jwt.claims'"));
  expect(setConfig).toBeDefined();
  return JSON.parse(String(setConfig!.params![0]));
}

describe("StreamRunCluster tenant claims", () => {
  it("sets the caller's tenant claim on every checkout, and none outside a scope", async () => {
    cluster = await StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));

    await runWithTenant({ tenantId: "tenant-a", userId: "user-a" }, () =>
      cluster!.withClient(async (c) => { await c.query("-- inside tenant-a"); }));
    await cluster.withClient(async (c) => { await c.query("-- outside"); });
    await runWithTenant({ tenantId: "tenant-b" }, () =>
      cluster!.withClient(async (c) => { await c.query("-- inside tenant-b"); }));

    expect(claimsSetBefore("-- inside tenant-a")).toMatchObject({ role: "tenant_app", tenant_id: "tenant-a", sub: "user-a" });
    const outside = claimsSetBefore("-- outside");
    expect(outside.role).toBe("service_role");
    expect(outside).not.toHaveProperty("tenant_id");
    expect(claimsSetBefore("-- inside tenant-b")).toMatchObject({ tenant_id: "tenant-b" });
    expect(claimsSetBefore("-- inside tenant-b")).not.toHaveProperty("sub");
  });

  // Issue 008: tenant work runs as tenant_app (RLS applies); platform work
  // outside a scope keeps service_role.
  it("sets the tenant role inside a scope and the platform role outside", async () => {
    cluster = await StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    await runWithTenant({ tenantId: "tenant-a" }, () =>
      cluster!.withClient(async (c) => { await c.query("-- inside"); }));
    await cluster.withClient(async (c) => { await c.query("-- outside"); });
    const roleBefore = (marker: string) =>
      queries.slice(0, queries.findIndex((q) => q.sql === marker)).reverse().find((q) => q.sql.startsWith("SET ROLE"))?.sql;
    expect(roleBefore("-- inside")).toBe("SET ROLE tenant_app");
    expect(roleBefore("-- outside")).toBe("SET ROLE service_role");
  });

  it("serves a relayed request as the requester's tenant", async () => {
    cluster = await StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    const seen: Array<string | undefined> = [];
    cluster.setHandler(async () => { seen.push(currentTenant()?.tenantId); return null; });
    const dispatch = (cluster as unknown as {
      dispatch(from: string, message: Record<string, unknown>): Promise<void>;
    }).dispatch.bind(cluster);
    const from = "00000000-0000-4000-8000-000000000001";
    // The fake pg has no peer key, so the reply fails after the handler ran.
    await dispatch(from, { kind: "request", requestId: "r1", op: "page", data: {}, tenantId: "tenant-a" }).catch(() => {});
    await dispatch(from, { kind: "request", requestId: "r2", op: "page", data: {} }).catch(() => {});
    expect(seen).toEqual(["tenant-a", undefined]);
  });
});
