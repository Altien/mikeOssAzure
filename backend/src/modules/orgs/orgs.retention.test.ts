import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../lib/supabase";

const mocks = vi.hoisted(() => ({ role: vi.fn(), capture: vi.fn(), complete: vi.fn() }));
vi.mock("../../lib/access", () => ({ getOrgRole: mocks.role }));
vi.mock("../documents/documents.service", () => ({
    captureInlineDocumentCleanup: mocks.capture, completeInlineDocumentCleanup: mocks.complete,
}));
import { expireDepartureArchives, listDepartureArchives, resolveDepartureArchive } from "./orgs.retention";

const actor = { orgId: "org", userId: "owner" };
function database(item: unknown = { kind: "document", item_id: "doc" }) {
    const query: any = {};
    for (const name of ["select", "eq", "lte", "order", "limit"]) query[name] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: item, error: null }));
    query.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ data: item ? [item] : [], error: null }).then(resolve);
    return { from: vi.fn(() => query), rpc: vi.fn(async () => ({ data: null as unknown, error: null as unknown })), query };
}
beforeEach(() => {
    vi.clearAllMocks(); mocks.role.mockResolvedValue("owner");
    mocks.capture.mockResolvedValue(["file.pdf"]); mocks.complete.mockResolvedValue(undefined);
});
describe("organization archive services", () => {
    it.each(["admin", "member", null])("does not read archive metadata for %s", async (role) => {
        mocks.role.mockResolvedValue(role);
        const db = database();
        for (const result of [
            await listDepartureArchives(db as unknown as Db, { ...actor, limit: 50, offset: 0 }),
            await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "a", delete: true }),
        ]) expect(result).toMatchObject({ ok: false, kind: role ? "forbidden" : "not_found" });
        expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
    });
    it("paginates through an RPC that rechecks owner authorization", async () => {
        const db = database(); db.rpc.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null });
        expect(await listDepartureArchives(db as unknown as Db, { ...actor, limit: 2, offset: 4 })).toEqual({
            ok: true, data: { items: [{ id: "a" }, { id: "b" }], nextOffset: 6 },
        });
        expect(db.rpc).toHaveBeenCalledWith("list_org_departure_archives", { p_org_id: "org", p_actor_id: "owner", p_limit: 3, p_offset: 4 });
    });
    it("scopes archive lookup to the organization and does not mutate a missing archive", async () => {
        const db = database(null);
        expect(await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "foreign", delete: true })).toMatchObject({ kind: "not_found" });
        expect(db.query.eq).toHaveBeenCalledWith("org_id", "org"); expect(db.rpc).not.toHaveBeenCalled();
    });
    it("finishes file cleanup only after a successful database deletion", async () => {
        const db = database(); db.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
        const args = { ...actor, archiveId: "a", delete: true };
        expect(await resolveDepartureArchive(db as unknown as Db, args)).toMatchObject({ kind: "forbidden" });
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(await resolveDepartureArchive(db as unknown as Db, args)).toEqual({ ok: true, data: null });
        expect(mocks.capture).toHaveBeenCalledWith(db, { documentIds: ["doc"] });
        expect(mocks.complete).toHaveBeenCalledWith(db, ["file.pdf"]);
    });
    it("requires a successor and reports expired recovery without leaking database errors", async () => {
        const db = database();
        expect(await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "a", delete: false })).toMatchObject({ kind: "validation" });
        db.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "private db details" } });
        const result = await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "a", delete: false, successorId: "member" });
        expect(result).toMatchObject({ kind: "conflict" }); expect(JSON.stringify(result)).not.toContain("private db details");
        expect(mocks.capture).not.toHaveBeenCalled();
    });
    it("expires in bounded batches and completes document cleanup", async () => {
        const db = database(); db.rpc.mockResolvedValue({ data: 1, error: null });
        expect(await expireDepartureArchives(db as unknown as Db)).toBe(1);
        expect(db.rpc).toHaveBeenCalledWith("expire_org_departure_archives", { p_limit: 100 });
        expect(mocks.complete).toHaveBeenCalledWith(db, ["file.pdf"]);
    });
});
