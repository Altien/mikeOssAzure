import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/types";

const mocks = vi.hoisted(() => ({ membership: vi.fn(), named: vi.fn(), source: vi.fn() }));
vi.mock("../tenantMemberships", () => ({ findTenantMembership: mocks.membership, findDirectoryMembership: mocks.named, findIdentitySourceTenant: mocks.source }));
import { resolveTenant, installTenantId, ensureInstallTenant } from "../tenantContext";

const env = ["TENANCY_MODE", "NODE_ENV"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(env.map(key => [key, process.env[key]]));
  process.env.TENANCY_MODE = "pooled"; process.env.NODE_ENV = "test";
  mocks.membership.mockReset().mockResolvedValue({ tenantId: "member-tenant", role: "Member" });
  mocks.named.mockReset().mockResolvedValue(undefined);
  mocks.source.mockReset().mockResolvedValue("enterprise-tenant");
});
afterEach(() => { for (const key of env) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
function principal(extra: Partial<AuthPrincipal>): AuthPrincipal {
  return { userId: "u", email: "u@example.test", groups: [], roles: [], provider: "entra", tenantId: "token-chosen", ...extra };
}
describe("pooled tenant resolution", () => {
  it("uses membership only for External ID and exposes the internal tenant", async () => {
    const p = principal({ identityKind: "altien", directoryId: "external" });
    expect(await resolveTenant(p)).toBe("member-tenant");
    expect(p.tenantId).toBe("member-tenant"); expect(p.membershipRole).toBe("Member");
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("falls back to the directory link, unchanged, when a Microsoft user has no named membership", async () => {
    const p = principal({ identityKind: "enterprise", directoryId: "directory" });
    expect(await resolveTenant(p)).toBe("enterprise-tenant");
    expect(p.membershipRole).toBeUndefined();
    expect(mocks.named).toHaveBeenCalledWith("directory", "u");
    expect(mocks.source).toHaveBeenCalledWith("directory"); expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("admits a named Microsoft member with its row's tenant and role before any directory link", async () => {
    mocks.named.mockResolvedValue({ tenantId: "named-tenant", role: "TenantAdmin" });
    const p = principal({ identityKind: "enterprise", directoryId: "directory" });
    expect(await resolveTenant(p)).toBe("named-tenant");
    expect(p.membershipRole).toBe("TenantAdmin");
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("never falls back to memberships for unknown enterprise directories", async () => {
    mocks.source.mockResolvedValue(undefined);
    expect(await resolveTenant(principal({ identityKind: "enterprise", directoryId: "unknown" }))).toBeUndefined();
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("re-reads membership for each request after a move", async () => {
    expect(await resolveTenant(principal({ identityKind: "altien" }))).toBe("member-tenant");
    mocks.membership.mockResolvedValue({ tenantId: "destination", role: "Member" });
    expect(await resolveTenant(principal({ identityKind: "altien" }))).toBe("destination");
    expect(mocks.membership).toHaveBeenCalledTimes(2);
  });
  it("ignores local token tenant claims and disallows production local pooled resolution", async () => {
    expect(await resolveTenant(principal({ provider: "local" }))).toBe("member-tenant");
    process.env.NODE_ENV = "production";
    expect(await resolveTenant(principal({ provider: "local" }))).toBeUndefined();
  });
  it("has no install fallback or automatic install tenant registration", async () => {
    expect(await installTenantId()).toBeUndefined();
    expect(await ensureInstallTenant({} as Parameters<typeof ensureInstallTenant>[0])).toBeUndefined();
  });
});
