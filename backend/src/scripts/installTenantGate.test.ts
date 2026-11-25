// The gate in front of migration 0176. 0176 picks the install tenant once and
// stamps every existing row with it, so a wrong pick has to be refused before
// the migration runs. Scratch PostgreSQL coverage of the same gate lives in
// __tests__/integration/installTenantGate.postgres.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertInstallTenantGate,
  decideInstallTenantGate,
  predictInstallTenant,
  TENANCY_MIGRATION,
  TENANCY_MIGRATION_TABLES,
  type InstallTenantSnapshot,
} from "./installTenantGate";

const EMPTY: InstallTenantSnapshot = { recorded: null, pooled: false, firstTenant: null, hasData: false };
const CONFIGURED = "configured-tenant";

describe("predictInstallTenant", () => {
  it("chooses nothing on a fresh database", () => {
    expect(predictInstallTenant(EMPTY)).toBeNull();
  });

  it("chooses the first tenants row, even when data exists", () => {
    expect(predictInstallTenant({ ...EMPTY, firstTenant: "row-tenant", hasData: true })).toEqual({
      tenant: "row-tenant",
      reason: "tenants-row",
    });
  });

  it("chooses default when data exists without a tenants row", () => {
    expect(predictInstallTenant({ ...EMPTY, hasData: true })).toEqual({ tenant: "default", reason: "data-without-tenant" });
  });

  it("keeps a value already recorded, as 0176 does", () => {
    expect(predictInstallTenant({ ...EMPTY, recorded: "kept", firstTenant: "row-tenant" })).toEqual({
      tenant: "kept",
      reason: "already-recorded",
    });
  });

  it("chooses nothing for a database already marked pooled", () => {
    expect(predictInstallTenant({ ...EMPTY, pooled: true, firstTenant: "row-tenant", hasData: true })).toBeNull();
  });
});

describe("decideInstallTenantGate", () => {
  const prediction = { tenant: "row-tenant", reason: "tenants-row" } as const;

  it("proceeds when the prediction is the configured tenant", () => {
    const decision = decideInstallTenantGate({ prediction, mode: "single", provider: "entra", configured: "row-tenant" });
    expect(decision).toEqual({ action: "proceed" });
  });

  it("proceeds on pooled tenancy, which has no install tenant", () => {
    const decision = decideInstallTenantGate({ prediction, mode: "pooled", provider: "entra", configured: null });
    expect(decision).toEqual({ action: "proceed" });
  });

  it("proceeds for default data when default is what is configured", () => {
    const decision = decideInstallTenantGate({
      prediction: { tenant: "default", reason: "data-without-tenant" },
      mode: "single",
      provider: "local",
      configured: "default",
    });
    expect(decision).toEqual({ action: "proceed" });
  });

  it("refuses a mismatch and names both values, the state and the way out", () => {
    const decision = decideInstallTenantGate({ prediction, mode: "single", provider: "entra", configured: CONFIGURED });
    expect(decision.action).toBe("refuse");
    const message = decision.action === "refuse" ? decision.message : "";
    expect(message).toContain("No migration has run");
    expect(message).toContain("row-tenant");
    expect(message).toContain(CONFIGURED);
    expect(message).toContain("entra-tenant-id");
    expect(message).toContain("docs/operator-checks.md");
  });

  it("explains a default pick on an entra install", () => {
    const decision = decideInstallTenantGate({
      prediction: { tenant: "default", reason: "data-without-tenant" },
      mode: "single",
      provider: "entra",
      configured: CONFIGURED,
    });
    expect(decision.action === "refuse" ? decision.message : "").toContain("public.tenants is empty");
  });

  it("names the non-entra setting for a non-entra mismatch", () => {
    const decision = decideInstallTenantGate({ prediction, mode: "single", provider: "local", configured: "default" });
    expect(decision.action === "refuse" ? decision.message : "").toContain("default-tenant-id");
  });

  it("refuses a single install that has no configured tenant", () => {
    const decision = decideInstallTenantGate({ prediction, mode: "single", provider: "entra", configured: null });
    expect(decision.action).toBe("refuse");
  });
});

describe("assertInstallTenantGate", () => {
  function fakeClient(snapshot: { tenants: string[]; hasData: boolean }) {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("to_regclass('app.install_tenancy')")) return { rows: [{ present: false }] };
        if (sql.includes("to_regclass('public.tenants')")) return { rows: [{ present: true }] };
        if (sql.includes("from public.tenants")) return { rows: snapshot.tenants.map((tenant_id) => ({ tenant_id })) };
        if (sql.includes("to_regclass($1)")) return { rows: [{ present: true }] };
        if (sql.includes("select exists")) return { rows: [{ has_data: snapshot.hasData }] };
        throw new Error("unexpected query");
      }),
    };
  }

  it("does nothing, and reads nothing, once 0176 is not pending", async () => {
    const client = fakeClient({ tenants: ["row-tenant"], hasData: true });
    const readConfig = vi.fn();
    await assertInstallTenantGate(client, ["0197_later"], readConfig);
    expect(client.query).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("does not need configuration on a fresh database", async () => {
    const readConfig = vi.fn(async () => {
      throw new Error("Stamp runtime requires entra-tenant-id");
    });
    await expect(
      assertInstallTenantGate(fakeClient({ tenants: [], hasData: false }), [TENANCY_MIGRATION], readConfig),
    ).resolves.toBeUndefined();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("refuses when the database and the configuration disagree", async () => {
    const readConfig = vi.fn(async () => ({ mode: "single" as const, provider: "entra", fallbackTenantId: CONFIGURED }));
    await expect(
      assertInstallTenantGate(fakeClient({ tenants: ["row-tenant"], hasData: true }), [TENANCY_MIGRATION], readConfig),
    ).rejects.toThrow(/No migration has run/);
  });

  it("stops rather than guessing when the configuration cannot be read", async () => {
    const readConfig = vi.fn(async () => {
      throw new Error("Stamp runtime requires entra-tenant-id");
    });
    await expect(
      assertInstallTenantGate(fakeClient({ tenants: ["row-tenant"], hasData: true }), [TENANCY_MIGRATION], readConfig),
    ).rejects.toThrow(/entra-tenant-id/);
  });
});

describe("the shipped migration", () => {
  it("checks the same tables for data as 0176 does", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../migrations", `${TENANCY_MIGRATION}.sql`), "utf8");
    const list = /v_tables text\[\] := array\[([\s\S]*?)\];/.exec(sql)?.[1] ?? "";
    const uncommented = list.replace(/--.*$/gm, "");
    const names = [...uncommented.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(50);
    expect([...TENANCY_MIGRATION_TABLES]).toEqual(names);
  });
});
