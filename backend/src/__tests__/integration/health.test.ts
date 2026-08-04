import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";

// requireAuth reads SUPABASE_URL / SUPABASE_SECRET_KEY from process.env at
// request time (not import time), so setting them here is early enough even
// though imported modules evaluate before this assignment runs.
process.env.SUPABASE_URL = "http://supabase.test.local";
process.env.SUPABASE_SECRET_KEY = "test-service-key";

// Mock the supabase-js client factory so the real requireAuth middleware never
// makes a network call: auth.getUser() resolves to no user for any token,
// simulating an invalid/expired JWT.
vi.mock("@supabase/supabase-js", () => ({
    createClient: vi.fn(() => ({
        from: () => {
            const q: Record<string, unknown> = {};
            const chain = [
                "select", "insert", "update", "delete", "upsert",
                "eq", "neq", "in", "is", "or", "not", "filter",
                "order", "limit",
            ];
            for (const m of chain) q[m] = () => q;
            q.single = () => Promise.resolve({ data: null, error: null });
            q.maybeSingle = () => Promise.resolve({ data: null, error: null });
            q.then = (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: null }).then(resolve);
            return q;
        },
        rpc: () => Promise.resolve({ data: null, error: null }),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: null }, error: null }),
        },
    })),
}));

// Vitest hoists vi.mock() calls before all imports, so this regular import
// receives the mocked supabase-js module even though it appears after the
// vi.mock() call in source order.
import { app } from "../../app";

describe("GET /health", () => {
    it("returns 200 with { ok: true }", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

describe("requireAuth middleware", () => {
    it("rejects requests with no Authorization header (401)", async () => {
        const res = await request(app).get("/chat");
        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty("detail");
    });

    it("rejects requests with a non-Bearer Authorization header (401)", async () => {
        const res = await request(app)
            .get("/chat")
            .set("Authorization", "Basic dXNlcjpwYXNz");
        expect(res.status).toBe(401);
    });

    it("rejects requests with an invalid Bearer token (401)", async () => {
        // The mocked createClient().auth.getUser returns { user: null } for
        // any token — simulating an expired/invalid token.
        const res = await request(app)
            .get("/chat")
            .set("Authorization", "Bearer invalid-token");
        expect(res.status).toBe(401);
        expect(res.body.detail).toMatch(/invalid|expired/i);
    });
});

describe("GET /manifest-signing-key", () => {
    afterEach(() => {
        delete process.env.MANIFEST_SIGNING_KEY;
    });

    it("returns null when the deployment does not sign manifests", async () => {
        const res = await request(app).get("/manifest-signing-key");
        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
    });

    it("serves the public key, never the seed, when signing is on", async () => {
        const seed = "7c".repeat(32);
        process.env.MANIFEST_SIGNING_KEY = seed;

        const res = await request(app).get("/manifest-signing-key");

        expect(res.status).toBe(200);
        expect(res.body.algorithm).toBe("ed25519");
        expect(res.body.public_key).toMatch(/^[0-9a-f]{64}$/);
        expect(res.body.public_key).not.toBe(seed);
        expect(res.text).not.toContain(seed);
    });

    it("is reachable without authentication", async () => {
        const res = await request(app).get("/manifest-signing-key");
        expect(res.status).not.toBe(401);
    });

    it("returns 500 rather than a stack trace when the key is malformed", async () => {
        process.env.MANIFEST_SIGNING_KEY = "nonsense";

        const res = await request(app).get("/manifest-signing-key");

        expect(res.status).toBe(500);
        expect(res.body.detail).toBe("Manifest signing key is misconfigured");
    });
});

describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
        const res = await request(app).get("/this-route-does-not-exist");
        expect(res.status).toBe(404);
    });
});
