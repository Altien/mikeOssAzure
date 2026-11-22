import { describe, expect, it } from "vitest";
import { resolvePooledRoles } from "./roles";
import type { AuthPrincipal } from "./types";
import type { Db } from "../supabase";
import { makeFakeDb } from "../../test/helpers/fakeDb";
function principal(extra: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return { userId: "admin", email: "admin@example.test", provider: "entra", groups: ["admins"],
    roles: [], identityKind: "enterprise", tenantId: "tenant-a", directoryId: "directory-a", ...extra };
}
describe("pooled tenant roles", () => {
  it.each(["Mike.Admin", "Mike Admin"])("accepts the supported admin value %s without group configuration", async value => {
    const fake = makeFakeDb(() => { throw new Error("App roles need no group query"); });
    expect(await resolvePooledRoles(principal({ appRoles: [value] }), fake.db as unknown as Db)).toEqual(["TenantAdmin", "Member"]);
    expect(fake.calls).toHaveLength(0);
  });
  it.each(["Mike.User", "Mike User"])("accepts the supported member value %s", async value => {
    const fake = makeFakeDb();
    expect(await resolvePooledRoles(principal({ appRoles: [value] }), fake.db as unknown as Db)).toEqual(["Member"]);
  });
  it("does not infer group fallback from an individual user's missing roles", async () => {
    const fake = makeFakeDb(call => ({ data: call.table === "tenants" ? { enterprise_role_source: "app_roles" } : [{ group_object_id: "admins", role: "TenantAdmin" }] }));
    expect(await resolvePooledRoles(principal(), fake.db as unknown as Db)).toEqual([]);
    expect(fake.callsFor("tenant_group_policies")).toHaveLength(0);
  });
  it("uses group fallback only when the tenant explicitly selects it", async () => {
    const fake = makeFakeDb(call => ({ data: call.table === "tenants" ? { enterprise_role_source: "groups" } : [{ group_object_id: "ADMINS", role: "TenantAdmin" }] }));
    expect(await resolvePooledRoles(principal(), fake.db as unknown as Db)).toEqual(["TenantAdmin", "Member"]);
    expect(fake.calls.every(call => call.filters.some(f => f[1] === "tenant_id" && f[2] === "tenant-a"))).toBe(true);
  });
  it("ignores app roles on External ID accounts and has no platform/staff role", async () => {
    const fake = makeFakeDb(() => ({ data: { enterprise_role_source: "app_roles" } }));
    expect(await resolvePooledRoles(principal({ identityKind: "altien", membershipRole: "Member", appRoles: ["Mike.Admin"] }), fake.db as unknown as Db)).toEqual(["Member"]);
    expect(await resolvePooledRoles(principal({ appRoles: ["PlatformAdmin", "AltienAdmin"] }), fake.db as unknown as Db)).toEqual([]);
  });
  it("gives a named Microsoft member exactly its membership role", async () => {
    const fake = makeFakeDb(() => { throw new Error("A named member needs no policy query"); });
    expect(await resolvePooledRoles(principal({ membershipRole: "TenantAdmin" }), fake.db as unknown as Db)).toEqual(["TenantAdmin", "Member"]);
    expect(await resolvePooledRoles(principal({ membershipRole: "Member", groups: [], appRoles: ["Mike.Admin"] }), fake.db as unknown as Db)).toEqual(["Member"]);
  });
  const adminPolicy = () => makeFakeDb(call => ({ data: call.table === "tenants" ? { enterprise_role_source: "app_roles" }
    : [{ group_object_id: "ADMINS", role: "TenantAdmin" }, { group_object_id: "staff", role: "Member" }] }));
  it("elevates a named Microsoft Member in the administrator group, whatever the role source", async () => {
    const fake = adminPolicy();
    expect(await resolvePooledRoles(principal({ membershipRole: "Member" }), fake.db as unknown as Db)).toEqual(["TenantAdmin", "Member"]);
    expect(fake.callsFor("tenants")).toHaveLength(0);
    expect(fake.calls.every(call => call.filters.some(f => f[1] === "tenant_id" && f[2] === "tenant-a"))).toBe(true);
  });
  it("does not elevate a named Microsoft Member outside the administrator group", async () => {
    expect(await resolvePooledRoles(principal({ membershipRole: "Member", groups: ["other"] }), adminPolicy().db as unknown as Db)).toEqual(["Member"]);
    expect(await resolvePooledRoles(principal({ membershipRole: "Member", groups: ["staff"] }), adminPolicy().db as unknown as Db)).toEqual(["Member"]);
  });
  it("runs no policy query for a named member without groups", async () => {
    const fake = makeFakeDb(() => { throw new Error("No groups need no policy query"); });
    expect(await resolvePooledRoles(principal({ membershipRole: "Member", groups: [] }), fake.db as unknown as Db)).toEqual(["Member"]);
    expect(await resolvePooledRoles(principal({ membershipRole: "Member", groups: undefined }), fake.db as unknown as Db)).toEqual(["Member"]);
    expect(fake.calls).toHaveLength(0);
  });
  it("never elevates External ID or local members by group", async () => {
    const fake = adminPolicy();
    expect(await resolvePooledRoles(principal({ identityKind: "altien", membershipRole: "Member" }), fake.db as unknown as Db)).toEqual(["Member"]);
    expect(await resolvePooledRoles(principal({ provider: "local", identityKind: undefined, membershipRole: "Member" }), fake.db as unknown as Db)).toEqual(["Member"]);
    expect(fake.calls).toHaveLength(0);
  });
  it("keeps a named TenantAdmin without a policy query", async () => {
    const fake = makeFakeDb(() => { throw new Error("A named admin needs no policy query"); });
    expect(await resolvePooledRoles(principal({ membershipRole: "TenantAdmin", groups: ["other"] }), fake.db as unknown as Db)).toEqual(["TenantAdmin", "Member"]);
  });
  it("fails closed when a named member's group policy cannot be read", async () => {
    const fake = makeFakeDb(() => ({ error: { message: "unavailable" } }));
    await expect(resolvePooledRoles(principal({ membershipRole: "Member" }), fake.db as unknown as Db)).rejects.toThrow("Tenant group policy is unavailable");
  });
  it("fails closed when the tenant policy cannot be read", async () => {
    const fake = makeFakeDb(() => ({ error: { message: "unavailable" } }));
    await expect(resolvePooledRoles(principal(), fake.db as unknown as Db)).rejects.toThrow("Tenant role policy is unavailable");
  });
});
