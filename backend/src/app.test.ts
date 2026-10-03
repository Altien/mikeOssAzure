import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp, isStaticAsset } from "./app";

describe("isStaticAsset (general rate-limit exemption)", () => {
    const get = (path: string) => isStaticAsset({ method: "GET", path });

    it("exempts bundled frontend assets", () => {
        expect(get("/_next/static/chunks/app-123.js")).toBe(true);
        expect(get("/_next/static/css/main.css")).toBe(true);
        expect(get("/icons/logo.svg")).toBe(true);
        expect(get("/projects/_/__next.!KHBhZ2VzKQ/assistant.txt")).toBe(true);
    });

    it("still limits API calls, pages and writes", () => {
        expect(get("/api/projects")).toBe(false);
        expect(get("/api/documents/report.txt")).toBe(false);
        expect(get("/projects/abc")).toBe(false);
        expect(get("/config")).toBe(false);
        expect(get("/install/items/operator-guide.txt")).toBe(false);
        expect(isStaticAsset({ method: "POST", path: "/_next/x.js" })).toBe(false);
    });
});

it("permits configured Word add-in CORS preflights and rejects other origins", async () => {
    const previous = process.env.WORD_ADDIN_URL;
    process.env.WORD_ADDIN_URL = "https://word.example.test";
    try {
        const app = buildApp();
        const allowed = await request(app).options("/api/word-chat")
            .set("Origin", "https://word.example.test")
            .set("Access-Control-Request-Method", "POST");
        expect(allowed.headers["access-control-allow-origin"]).toBe("https://word.example.test");
        const rejected = await request(app).options("/api/word-chat")
            .set("Origin", "https://unconfigured.example.test")
            .set("Access-Control-Request-Method", "POST");
        expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
        if (previous === undefined) delete process.env.WORD_ADDIN_URL;
        else process.env.WORD_ADDIN_URL = previous;
    }
});

it("buildApp binds safe malformed-JSON errors and a request ID on /api", async () => {
    const response = await request(buildApp())
        .post("/api/chat")
        .set("Content-Type", "application/json")
        .send('{"private-token":');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
        code: "invalid_json",
        detail: "Request body must contain valid JSON.",
    });
    expect(response.body.request_id).toBe(response.headers["x-request-id"]);
    expect(response.text).not.toContain("private-token");
});

it("limits the full /api Word tool-result path independently and parses it at 2 MB", async () => {
    const previous = process.env.RATE_LIMIT_GENERAL_MAX;
    process.env.RATE_LIMIT_GENERAL_MAX = "1";
    try {
        const app = buildApp();
        const first = await request(app).post("/api/word-chat/tool-result").send({});
        const second = await request(app).post("/api/word-chat/tool-result").send({});
        expect(first.status).not.toBe(429);
        expect(second.status).not.toBe(429);

        const oversized = await request(app)
            .post("/api/word-chat/tool-result")
            .send({ result: "x".repeat(2 * 1024 * 1024) });
        expect(oversized.status).toBe(413);
    } finally {
        if (previous === undefined) delete process.env.RATE_LIMIT_GENERAL_MAX;
        else process.env.RATE_LIMIT_GENERAL_MAX = previous;
    }
});
