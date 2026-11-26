// Multi-tenant issue 003: StreamRunCluster's raw pg connections carry the same
// request.jwt.claims as PostgREST traffic, so stream_runs.tenant_id defaults
// to the caller's tenant (migration 0179). A fake `pg` records the SQL.

import { afterEach, describe, expect, it, vi } from "vitest";

const { queries, denied } = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params?: unknown[] }>,
  denied: { sql: "", code: "42501" as string | undefined, asRole: "" },
}));

vi.mock("pg", () => {
  class FakeClient {
    role = "";
    async connect() {}
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.startsWith("SET ROLE ")) this.role = sql.slice("SET ROLE ".length);
      if (denied.sql && sql === denied.sql && (!denied.asRole || this.role === denied.asRole)) {
        throw Object.assign(new Error("raw driver text postgres://login:hunter2@db/mike"), { code: denied.code });
      }
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
import { resetPostgrestJwtState } from "../supabase";
import { currentTenant, runWithTenant } from "../tenantContext";

let cluster: StreamRunCluster | null = null;
afterEach(async () => {
  await cluster?.close();
  cluster = null;
  queries.length = 0;
  denied.sql = "";
  denied.code = "42501";
  denied.asRole = "";
  vi.unstubAllEnvs();
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

  it("proves the tenant role at startup, read-only, not just service_role", async () => {
    cluster = await StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    const role = queries.findIndex((q) => q.sql === "SET ROLE tenant_app");
    expect(role).toBeGreaterThan(-1);
    expect(queries.slice(role).map((q) => q.sql)).toContain("select id from public.stream_runs limit 1");
    expect(queries.filter((q) => q.sql.startsWith("SET ROLE tenant_app")).length).toBe(1);
  });

  it("fails startup with guidance and only the code when the login lacks the tenant role", async () => {
    denied.sql = "SET ROLE tenant_app";
    const start = StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    const error = await start.catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("role tenant_app");
    expect(error.message).toContain("code 42501");
    expect(error.message).toContain("GRANT tenant_app TO <login>");
    expect(error.message).toContain("tenant-rls-enforced=false");
    expect(error.message).not.toContain("hunter2");
    expect(error.cause).toBeUndefined();
  });

  it("says the role lacks a table grant when the read is refused after the role switch", async () => {
    denied.sql = "select id from public.stream_runs limit 1";
    denied.asRole = "tenant_app";
    const start = StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    const error = await start.catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("role tenant_app could not read public.stream_runs (code 42501)");
    expect(error.message).toContain("run the migration job");
    expect(error.message).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.stream_runs TO tenant_app");
    expect(error.message).not.toContain("could not use role");
    expect(error.message).not.toContain("GRANT tenant_app TO");
    expect(error.message).not.toContain("tenant-rls-enforced");
  });

  it("says the role may not exist on a 22023 at the switch, as the PostgREST path does", async () => {
    denied.sql = "SET ROLE tenant_app";
    denied.code = "22023";
    const start = StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    const error = await start.catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("could not switch to role tenant_app (code 22023)");
    expect(error.message).toContain("Role tenant_app may not exist in this database. Run the migration job.");
    expect(error.message).not.toContain("GRANT");
    expect(error.message).not.toContain("tenant-rls-enforced");
  });

  it.each(["ECONNRESET", "57P01", "08006", undefined])(
    "does not blame the role, or offer a grant or rollback, for a connection failure (%s)",
    async (code) => {
      denied.sql = "SET ROLE tenant_app";
      denied.code = code;
      const start = StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
      const error = await start.catch((caught: Error) => caught) as Error;
      expect(error.message).toContain("stream-run connection failed");
      expect(error.message).toContain(`code ${code ?? "no code"}`);
      expect(error.message).not.toContain("could not use role");
      expect(error.message).not.toContain("GRANT");
      expect(error.message).not.toContain("tenant-rls-enforced");
      expect(error.message).not.toContain("hunter2");
    },
  );

  it("does not ask for tenant_app under the rollback switch", async () => {
    vi.stubEnv("TENANT_RLS_ENFORCED", "false");
    resetPostgrestJwtState();
    denied.sql = "SET ROLE tenant_app";
    cluster = await StreamRunCluster.startForTests("postgres://localhost:5432/mike", Buffer.alloc(32, 7));
    expect(queries.map((q) => q.sql)).not.toContain("SET ROLE tenant_app");
    resetPostgrestJwtState();
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
