import { describe, expect, it } from "vitest";
import { normalizeSearchTerm } from "../search";

describe("normalizeSearchTerm", () => {
    it("trims whitespace and preserves meaningful search text", () => {
        expect(normalizeSearchTerm("  merger agreement  ")).toBe("merger agreement");
    });

    it("returns null for empty or missing values", () => {
        expect(normalizeSearchTerm("   ")).toBeNull();
        expect(normalizeSearchTerm(undefined)).toBeNull();
    });
});
