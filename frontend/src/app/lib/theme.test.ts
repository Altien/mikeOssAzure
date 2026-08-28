import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDarkMode, applyTransparentTables } from "./theme";

afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.remove("transparent-tables");
    document.documentElement.style.colorScheme = "";
});

describe("applyTransparentTables", () => {
    it("toggles transparent table styling on the document root", () => {
        applyTransparentTables(true);
        expect(document.documentElement).toHaveClass("transparent-tables");

        applyTransparentTables(false);
        expect(document.documentElement).not.toHaveClass(
            "transparent-tables",
        );
    });

    it("does nothing when rendered without a document", () => {
        vi.stubGlobal("document", undefined);
        expect(() => applyTransparentTables(true)).not.toThrow();
    });
});

describe("applyDarkMode", () => {
    it("enables dark colors on the document root", () => {
        applyDarkMode(true);
        expect(document.documentElement.classList.contains("dark")).toBe(true);
        expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("returns the document root to light mode", () => {
        document.documentElement.classList.add("dark");
        applyDarkMode(false);
        expect(document.documentElement.classList.contains("dark")).toBe(false);
        expect(document.documentElement.style.colorScheme).toBe("light");
    });

    it("does nothing when rendered without a document", () => {
        vi.stubGlobal("document", undefined);
        expect(() => applyDarkMode(true)).not.toThrow();
    });
});
