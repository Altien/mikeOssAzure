import { describe, expect, it } from "vitest";
import type { Db } from "../supabase";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import { findIdentitySourceTenant, findTenantMembership, mirrorEnterpriseMembership } from "../tenantMemberships";

describe("tenant membership resolver", () => {
  it("resolves the current membership afresh after a move", async () => {
    let tenant = "before";
    const fake = makeFakeDb(() => ({ data: { tenant_id: tenant, role: "Member", identity_kind: "altien" } }));
    expect(await findTenantMembership("user", fake.db as unknown as Db)).toEqual({ tenantId: "before", role: "Member" });
    tenant = "after";
    expect(await findTenantMembership("user", fake.db as unknown as Db)).toEqual({ tenantId: "after", role: "Member" });
    expect(fake.calls.every(call => call.filters.some(([op, key, value]) => op === "eq" && key === "user_id" && value === "user"))).toBe(true);
  });
  it("returns no tenant for an unregistered identity", async () => {
    const fake = makeFakeDb(() => ({ data: null }));
    expect(await findTenantMembership("unknown", fake.db as unknown as Db)).toBeUndefined();
    expect(await findIdentitySourceTenant("unknown", fake.db as unknown as Db)).toBeUndefined();
  });
  it("fails closed on a database failure or invalid role", async () => {
    const broken = makeFakeDb(() => ({ error: { message: "database detail" } }));
    await expect(findTenantMembership("user", broken.db as unknown as Db)).rejects.toThrow("Tenant membership is unavailable");
    await expect(findIdentitySourceTenant("tid", broken.db as unknown as Db)).rejects.toThrow("Tenant identity source is unavailable");
    const invalid = makeFakeDb(() => ({ data: { tenant_id: "tenant", role: "PlatformAdmin", identity_kind: "altien" } }));
    await expect(findTenantMembership("user", invalid.db as unknown as Db)).rejects.toThrow("Invalid tenant membership");
  });
  it("uses the verified directory identifier, normalised for matching", async () => {
    const fake = makeFakeDb(() => ({ data: { tenant_id: "enterprise" } }));
    expect(await findIdentitySourceTenant(" DIRECTORY ", fake.db as unknown as Db)).toBe("enterprise");
    expect(fake.calls[0].filters).toContainEqual(["eq", "tid", "directory"]);
  });
});

it("never resolves an enterprise mirror as an External ID/local membership", async () => {
  const fake = makeFakeDb(() => ({ data: { tenant_id: "tenant", role: "TenantAdmin", identity_kind: "enterprise", directory_id: "directory" } }));
  expect(await findTenantMembership("user", fake.db as unknown as Db)).toBeUndefined();
});
it("mirrors an admitted enterprise identity through the bound platform-only operation", async () => {
  const fake = makeFakeDb();
  await mirrorEnterpriseMembership("tenant", "user", "directory", "TenantAdmin", fake.db as unknown as Db);
  expect(fake.calls).toEqual([{ table: "mirror_enterprise_member", op: "rpc", filters: [],
    payload: { p_tenant_id: "tenant", p_user_id: "user", p_directory_id: "directory", p_role: "TenantAdmin" } }]);
  const broken = makeFakeDb(() => ({ error: { message: "identity source conflict" } }));
  await expect(mirrorEnterpriseMembership("tenant", "user", "directory", "Member", broken.db as unknown as Db)).rejects.toThrow("Enterprise membership is unavailable");
});
