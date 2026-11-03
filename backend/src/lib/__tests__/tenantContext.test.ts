import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT_ID,
  callerSite,
  currentTenant,
  ensureInstallTenant,
  installTenantId,
  resetTenantConfigCache,
  resolveTenant,
  runWithJobTenant,
  runWithTenant,
  stampJobTenant,
} from "../tenantContext";
import type { AuthPrincipal } from "../auth/types";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import type { Db } from "../supabase";

const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "DEFAULT_TENANT_ID",
  "ENTRA_TENANT_ID",
  "TENANT_ONBOARDING_MODE",
  "KEY_VAULT_NAME",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
  for (const key of TOUCHED_ENV) delete process.env[key];
  resetTenantConfigCache();
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetTenantConfigCache();
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function principal(overrides: Partial<AuthPrincipal>): AuthPrincipal {
  return { userId: "u1", email: "u1@example.test", groups: [], roles: [], provider: "local", ...overrides };
}

describe("runWithTenant / currentTenant", () => {
  it("is undefined outside a scope", () => {
    expect(currentTenant()).toBeUndefined();
  });

  it("is visible inside the scope and in awaited calls it makes", async () => {
    async function deepService(): Promise<string | undefined> {
      await tick(1);
      return currentTenant()?.tenantId;
    }
    const seen = await runWithTenant({ tenantId: "t-a", userId: "u-a" }, async () => {
      expect(currentTenant()).toEqual({ tenantId: "t-a", userId: "u-a" });
      return deepService();
    });
    expect(seen).toBe("t-a");
    expect(currentTenant()).toBeUndefined();
  });

  it("never lets two concurrent scopes observe each other", async () => {
    const observed: Record<string, string[]> = { a: [], b: [] };
    const request = (name: "a" | "b", tenantId: string, delays: number[]) =>
      runWithTenant({ tenantId, userId: `user-${name}` }, async () => {
        for (const delay of delays) {
          await tick(delay);
          observed[name].push(`${currentTenant()?.tenantId}/${currentTenant()?.userId}`);
        }
      });
    // Interleave the two flows so each resumes while the other is suspended.
    await Promise.all([
      request("a", "tenant-a", [5, 1, 7, 2]),
      request("b", "tenant-b", [1, 6, 1, 5]),
    ]);
    expect(observed.a).toEqual(Array(4).fill("tenant-a/user-a"));
    expect(observed.b).toEqual(Array(4).fill("tenant-b/user-b"));
  });

  it("nests: an inner scope wins and the outer one is restored", async () => {
    await runWithTenant({ tenantId: "outer" }, async () => {
      await runWithTenant({ tenantId: "inner" }, async () => {
        await tick(1);
        expect(currentTenant()?.tenantId).toBe("inner");
      });
      expect(currentTenant()?.tenantId).toBe("outer");
    });
  });

  it("refuses an empty tenant id and freezes the context", () => {
    expect(() => runWithTenant({ tenantId: " " }, () => 1)).toThrow(/tenantId/);
    runWithTenant({ tenantId: "t" }, () => {
      expect(Object.isFrozen(currentTenant())).toBe(true);
    });
  });
});

describe("resolveTenant", () => {
  it("entra: uses the validated token tid", async () => {
    await expect(resolveTenant(principal({ provider: "entra", tenantId: "tid-1" }))).resolves.toBe("tid-1");
  });

  it("entra: no tid means no tenant (tenantAccess denies)", async () => {
    await expect(resolveTenant(principal({ provider: "entra" }))).resolves.toBeUndefined();
  });

  it("local / supabase: falls back to the default key", async () => {
    await expect(resolveTenant(principal({ provider: "local" }))).resolves.toBe(DEFAULT_TENANT_ID);
    await expect(resolveTenant(principal({ provider: "supabase" }))).resolves.toBe(DEFAULT_TENANT_ID);
  });

  it("local / supabase: honours default-tenant-id and ignores any tid on the principal", async () => {
    process.env.DEFAULT_TENANT_ID = "acme";
    await expect(resolveTenant(principal({ provider: "local", tenantId: "spoofed" }))).resolves.toBe("acme");
  });
});

describe("installTenantId", () => {
  it("entra: the configured entra-tenant-id", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tid-cfg";
    await expect(installTenantId()).resolves.toBe("tid-cfg");
  });

  it("local: the default key", async () => {
    process.env.AUTH_PROVIDER = "local";
    await expect(installTenantId()).resolves.toBe(DEFAULT_TENANT_ID);
  });
});

describe("ensureInstallTenant", () => {
  it("local: inserts the default tenant if absent", async () => {
    process.env.AUTH_PROVIDER = "local";
    const fake = makeFakeDb();
    await expect(ensureInstallTenant(fake.db as unknown as Db)).resolves.toBe(DEFAULT_TENANT_ID);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: "tenants",
      op: "upsert",
      payload: { tenant_id: DEFAULT_TENANT_ID, status: "active" },
    });
  });

  it("entra + manual onboarding: writes nothing", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tid-cfg";
    const fake = makeFakeDb();
    await expect(ensureInstallTenant(fake.db as unknown as Db)).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("entra + auto onboarding: registers the configured tenant", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tid-cfg";
    process.env.TENANT_ONBOARDING_MODE = "auto";
    const fake = makeFakeDb();
    await expect(ensureInstallTenant(fake.db as unknown as Db)).resolves.toBe("tid-cfg");
    expect(fake.calls[0]).toMatchObject({ table: "tenants", payload: { tenant_id: "tid-cfg" } });
  });

  it("fails loudly when the row cannot be written", async () => {
    process.env.AUTH_PROVIDER = "local";
    const fake = makeFakeDb(() => ({ error: { message: "boom" } }));
    await expect(ensureInstallTenant(fake.db as unknown as Db)).rejects.toThrow(/install tenant/);
  });
});

describe("callerSite", () => {
  it("returns the first application frame, skipping the client and dependencies", () => {
    const stack = [
      "Error",
      "    at recordNoTenantContext (C:/app/backend/src/lib/tenantContext.ts:90:3)",
      "    at fetch (C:/app/backend/src/lib/supabase.ts:140:7)",
      "    at PostgrestBuilder.then (C:/app/backend/node_modules/@supabase/postgrest-js/dist/index.js:1:1)",
      "    at loadChats (C:/app/backend/src/modules/chat/chat.crud.ts:42:19)",
    ].join("\n");
    expect(callerSite(stack)).toBe("modules/chat/chat.crud.ts:42");
  });

  it("is 'unknown' when only library frames are present", () => {
    expect(callerSite("Error\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)")).toBe("unknown");
  });
});

describe("runWithJobTenant / stampJobTenant", () => {
  it("preserves a trusted background actor without borrowing the ambient user", async () => {
    await expect(runWithJobTenant("t-job", async () => currentTenant(), "job-user")).resolves.toEqual({ tenantId: "t-job", userId: "job-user" });
  });
  it("runs as the recorded tenant, else the install tenant", async () => {
    process.env.AUTH_PROVIDER = "local";
    await expect(runWithJobTenant("t-job", async () => currentTenant()?.tenantId)).resolves.toBe("t-job");
    await expect(runWithJobTenant(null, async () => currentTenant()?.tenantId)).resolves.toBe(DEFAULT_TENANT_ID);
  });

  it("runs with no context when there is no install tenant", async () => {
    process.env.AUTH_PROVIDER = "entra";
    await expect(runWithJobTenant(undefined, async () => currentTenant())).resolves.toBeUndefined();
  });

  it("stamps the current tenant onto a queue message, never overriding one", () => {
    expect(stampJobTenant({ a: 1 } as { a: number; tenantId?: string })).toEqual({ a: 1 });
    runWithTenant({ tenantId: "t-req" }, () => {
      expect(stampJobTenant({ a: 1 } as { a: number; tenantId?: string })).toEqual({ a: 1, tenantId: "t-req" });
      expect(stampJobTenant({ a: 1, tenantId: "t-own" })).toEqual({ a: 1, tenantId: "t-own" });
    });
  });
});

it("freezes resolved roles without lending admin authority to background jobs", async () => {
  const roles = ["TenantAdmin", "Member"];
  await runWithTenant({ tenantId: "tenant", userId: "admin", roles, pooled: true, readOnly: true }, async () => {
    roles.push("unexpected");
    expect(currentTenant()?.roles).toEqual(["TenantAdmin", "Member"]);
    expect(Object.isFrozen(currentTenant()?.roles)).toBe(true);
    await runWithJobTenant("tenant", async () => {
      expect(currentTenant()).toEqual({ tenantId: "tenant", userId: "worker" });
    }, "worker");
    expect(currentTenant()?.readOnly).toBe(true);
  });
});
