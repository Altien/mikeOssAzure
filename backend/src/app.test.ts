import { describe, expect, it } from "vitest";
import { isStaticAsset } from "./app";

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
