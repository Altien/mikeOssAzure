import { describe, expect, it } from "vitest";
import type { Db } from "../../../lib/supabase";
import { runWithTenant } from "../../../lib/tenantContext";
import { makeFakeDb } from "../../../test/helpers/fakeDb";
import { tenantAdminContent, tenantAdminOverview, reassignTenantContent, tenantAdminStatus } from "../tenant-admin.service";
const actor = { tenantId: "tenant-a", userId: "admin", roles: ["TenantAdmin", "Member"], pooled: true, readOnly: true };
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
describe("tenant administration", () => {
  it("denies ordinary Members before touching the database", async () => {
    const fake = makeFakeDb();
    await runWithTenant({ ...actor, roles: ["Member"] }, async () => {
      expect(tenantAdminStatus()).toEqual({ isTenantAdmin: false });
      expect(await tenantAdminContent(fake.db as unknown as Db, { kind: "project", offset: 0, limit: 50 })).toMatchObject({ ok: false, kind: "forbidden" });
      expect(await tenantAdminOverview(fake.db as unknown as Db)).toMatchObject({ ok: false, kind: "forbidden" });
      expect(await reassignTenantContent(fake.db as unknown as Db, { kind: "project", id, newOwnerId: "new-owner", reason: "Departed member" })).toMatchObject({ ok: false, kind: "forbidden" });
    });
    expect(fake.calls).toHaveLength(0);
  });
  it("audits the returned page with each owner/object and scopes its query", async () => {
    const fake = makeFakeDb(call => ({ data: call.table === "projects" ? [
      { id, name: "Matter", user_id: "owner", created_at: "2026-10-01" }, { id: "next", name: "Next" },
    ] : null }));
    const result = await runWithTenant(actor, () => tenantAdminContent(fake.db as unknown as Db, { kind: "project", offset: 0, limit: 1 }));
    expect(result).toMatchObject({ ok: true, data: { hasMore: true, items: [{ id, ownerId: "owner", kind: "project", title: "Matter" }] } });
    expect(fake.callsFor("projects")[0].filters).toContainEqual(["eq", "tenant_id", "tenant-a"]);
    expect(fake.callsFor("projects")[0].filters).toContainEqual(["eq", "project_kind", "workspace"]);
    expect(fake.callsFor("audit_events")[0].payload).toMatchObject({ detail: { actor: "admin", reason: "organisation_content_listing", objects: [{ id, owner: "owner", kind: "project" }] } });
  });
  it("returns no content page if its audit cannot be recorded", async () => {
    const fake = makeFakeDb(call => call.table === "audit_events" ? { error: { message: "unavailable" } } : { data: [{ id, name: "Secret" }] });
    expect(await runWithTenant(actor, () => tenantAdminContent(fake.db as unknown as Db, { kind: "project", offset: 0, limit: 50 }))).toMatchObject({ ok: false, kind: "error" });
  });
  it("keeps credit precision and uses database-side monthly rollups", async () => {
    const fake = makeFakeDb(call => ({ data: call.table === "tenant_admin_members" ? [{ userId: "owner", role: "Member" }]
      : call.table === "tenant_admin_usage" ? { periodStart: "2026-10-01", totalTokens: 4, totalCredits: "9007199254740993.0001", byUser: [] }
      : call.table === "tenant_budgets" ? { monthly_credits: "9007199254740993.0002", per_user_credits: null, soft_threshold: "0.8" }
      : { used_credits: "9007199254740993.0001", reserved_credits: "0.0001" } }));
    expect(await runWithTenant(actor, () => tenantAdminOverview(fake.db as unknown as Db))).toMatchObject({ ok: true, data: {
      usage: { totalCredits: "9007199254740993.0001" }, budget: { monthlyCredits: "9007199254740993.0002", usedCredits: "9007199254740993.0001", reservedCredits: "0.0001" },
    } });
    expect(fake.callsFor("tenant_budgets")[0].columns).toContain("monthly_credits::text");
  });
  it("calls only the atomic reassignment RPC and supplies the audit reason", async () => {
    const fake = makeFakeDb();
    expect(await runWithTenant({ ...actor, readOnly: false }, () => reassignTenantContent(fake.db as unknown as Db,
      { kind: "project", id, newOwnerId: "new-owner", reason: "  Departed member  " }))).toEqual({ ok: true, data: { ok: true } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ op: "rpc", table: "tenant_admin_reassign", payload: { p_id: id, p_new_owner: "new-owner", p_reason: "Departed member" } });
  });
  it("maps ineligible organisation members and synthetic libraries to an intentional 4xx", async () => {
    const fake = makeFakeDb(() => ({ error: { message: "raw internal SQL", code: "22023" } as never }));
    const result = await runWithTenant(actor, () => reassignTenantContent(fake.db as unknown as Db, { kind: "project", id, newOwnerId: "new-owner", reason: "Departed member" }));
    expect(result).toMatchObject({ ok: false, kind: "validation" });
    expect(JSON.stringify(result)).not.toContain("raw internal SQL");
  });
  it("rejects invalid/prototype kinds and malformed pages before querying", async () => {
    const fake = makeFakeDb();
    expect(await runWithTenant(actor, () => tenantAdminContent(fake.db as unknown as Db, { kind: "toString", offset: 0, limit: 50 }))).toMatchObject({ ok: false, kind: "validation" });
    expect(await runWithTenant(actor, () => tenantAdminContent(fake.db as unknown as Db, { kind: "project", offset: -1, limit: 50 }))).toMatchObject({ ok: false, kind: "validation" });
    expect(fake.calls).toHaveLength(0);
  });
});
