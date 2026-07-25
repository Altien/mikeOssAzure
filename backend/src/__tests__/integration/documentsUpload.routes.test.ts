import { describe, it, expect, vi } from "vitest";
import request from "supertest";

function mockSupabase() {
    const result = { data: null, error: null };
    const q: Record<string, unknown> = {};
    const chain = [
        "select", "insert", "update", "delete", "upsert",
        "eq", "neq", "in", "is", "or", "not", "lt", "order", "limit",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
    return {
        from: vi.fn(() => q),
        rpc: vi.fn(() => Promise.resolve(result)),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
    getUserIdFromRequest: vi.fn(async () => "u1"),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Stub the storage IO functions so a request that clears validation never
// touches R2/S3, while keeping the rest of the storage module (key builders,
// disposition helpers) real. The validation tests below reject before storage
// is reached, but this guards against accidental real IO regardless.
vi.mock("../../lib/storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/storage")>();
    return {
        ...actual,
        uploadFile: vi.fn(async () => {}),
        downloadFile: vi.fn(async () => null),
        deleteFile: vi.fn(async () => {}),
    };
});

import { app } from "../../app";

describe("POST /single-documents — upload validation", () => {
    it("rejects an unsupported file extension with 400", async () => {
        const res = await request(app)
            .post("/single-documents")
            .set("Authorization", "Bearer test")
            .attach("file", Buffer.from("hello world"), {
                filename: "notes.txt",
                contentType: "text/plain",
            });

        expect(res.status).toBe(400);
        expect(res.body.detail).toMatch(/unsupported file type/i);
    });

    it("rejects a request with no file attached with 400", async () => {
        const res = await request(app)
            .post("/single-documents")
            .set("Authorization", "Bearer test")
            .field("note", "no file here");

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("file is required");
    });
});

describe("POST /single-documents/download-zip — bounds", () => {
    it("returns 400 when document_ids is empty", async () => {
        const res = await request(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test")
            .send({ document_ids: [] });

        expect(res.status).toBe(400);
        expect(res.body.detail).toMatch(/document_ids is required/i);
    });

    it("returns 404 when none of the requested documents are accessible", async () => {
        // The documents lookup resolves to no rows (stubbed DB), so the
        // access filter leaves nothing to zip.
        const res = await request(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test")
            .send({ document_ids: ["d-other-user"] });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("No documents found");
    });
});
