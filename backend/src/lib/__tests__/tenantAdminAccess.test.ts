import { describe, expect, it, vi } from "vitest";
import type { Db } from "../supabase";
import { runWithTenant } from "../tenantContext";
import { checkProjectAccess, checkWorkflowAccess, ensureDocAccess, ensureChatAccess, ensureReviewAccess } from "../access";
import { makeFakeDb } from "../../test/helpers/fakeDb";
const actor = { tenantId: "tenant-a", userId: "admin", roles: ["TenantAdmin", "Member"], pooled: true, readOnly: true };
const row = { id: "object-id", user_id: "owner", tenant_id: "tenant-a", project_id: null, workflow_id: null, org_id: null };
const readers = {
  project: (db: Db, userId = "admin") => checkProjectAccess(row.id, userId, null, db),
  workflow: (db: Db, userId = "admin") => checkWorkflowAccess(row.id, userId, null, db),
  document: (db: Db, userId = "admin") => ensureDocAccess(row, userId, null, db),
  chat: (db: Db, userId = "admin") => ensureChatAccess(row, userId, null, db),
  review: (db: Db, userId = "admin") => ensureReviewAccess(row, userId, null, db),
};
function fixture(tenantId = "tenant-a", auditFails = false) {
  return makeFakeDb(call => {
    if (["projects", "workflows", "documents", "chats", "tabular_reviews"].includes(call.table)) return { data: { ...row, tenant_id: tenantId } };
    if (call.table === "audit_events") return auditFails ? { error: { message: "audit unavailable" } } : { data: null };
    return { data: [] };
  });
}
describe("audited pooled tenant-admin read access", () => {
  it.each(Object.entries(readers))("grants only Viewer for %s and commits actor/owner/object/reason", async (kind, read) => {
    const fake = fixture();
    const result = await runWithTenant(actor, () => read(fake.db as unknown as Db));
    expect(result).toMatchObject({ ok: true, projectRole: "viewer", isCreator: false, orgRole: null });
    const audit = fake.callsFor("audit_events", "insert");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ user_id: "admin", action: "tenant_admin.content_read",
      detail: { actor: "admin", owner: "owner", object: { kind, id: row.id }, reason: "tenant_admin_read" } });
    expect(fake.calls.some(call => call.filters.some(f => f[1] === "tenant_id" && f[2] === actor.tenantId))).toBe(true);
  });
  it.each(Object.entries(readers))("denies %s across tenant boundaries even if a fake returns a foreign row", async (_kind, read) => {
    const fake = fixture("tenant-b");
    expect(await runWithTenant(actor, () => read(fake.db as unknown as Db))).toEqual({ ok: false });
    expect(fake.callsFor("audit_events")).toHaveLength(0);
  });
  it.each(Object.entries(readers))("fails closed for %s when the audit fails", async (_kind, read) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fixture("tenant-a", true);
    expect(await runWithTenant(actor, () => read(fake.db as unknown as Db))).toEqual({ ok: false });
  });
  it.each([
    { ...actor, readOnly: false }, { ...actor, pooled: false }, { ...actor, roles: ["Member"] },
  ])("does not widen access for mutations, single mode or Members", async context => {
    const fake = fixture();
    for (const read of Object.values(readers)) expect(await runWithTenant(context, () => read(fake.db as unknown as Db))).toEqual({ ok: false });
    expect(fake.callsFor("audit_events")).toHaveLength(0);
  });
  it("never borrows another actor's ambient role or grants a document without its object ID", async () => {
    const fake = fixture();
    expect(await runWithTenant(actor, () => readers.project(fake.db as unknown as Db, "different-user"))).toEqual({ ok: false });
    expect(await runWithTenant(actor, () => ensureDocAccess({ user_id: "owner", project_id: null }, "admin", null, fake.db as unknown as Db))).toEqual({ ok: false });
    expect(fake.callsFor("audit_events")).toHaveLength(0);
  });
  it("audits the actual child rather than a parent-shaped grant", async () => {
    const fake = fixture();
    expect(await runWithTenant(actor, () => ensureDocAccess({ ...row, project_id: "parent" }, "admin", null, fake.db as unknown as Db))).toMatchObject({ ok: true, projectRole: "viewer" });
    expect(fake.callsFor("audit_events")).toHaveLength(1);
    expect(fake.callsFor("audit_events")[0].payload).toMatchObject({ detail: { object: { kind: "document", id: row.id } } });
  });
  it("does not audit ordinary ownership access or turn an existing Owner into a Viewer", async () => {
    const fake = makeFakeDb(() => ({ data: { ...row, user_id: "admin" } }));
    expect(await runWithTenant(actor, () => readers.project(fake.db as unknown as Db))).toMatchObject({ ok: true, projectRole: "owner", isCreator: true });
    expect(fake.callsFor("audit_events")).toHaveLength(0);
  });
});
