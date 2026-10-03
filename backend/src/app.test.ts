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
