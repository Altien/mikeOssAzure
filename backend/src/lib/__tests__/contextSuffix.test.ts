import { describe, expect, it } from "vitest";
import { buildContextSuffix } from "../contextSuffix";

describe("buildContextSuffix", () => {
    it("returns no prompt for ordinary web chat requests", () => {
        expect(buildContextSuffix({})).toBe("");
    });

    it("describes Word edit, write, and selection behavior", () => {
        const result = buildContextSuffix({
            editMode: "track",
            creationMode: "this_word_doc",
            selection: { has_selection: true, text: "Selected clause" },
        });

        expect(result).toContain("WORD EDIT MODE - TRACK CHANGES");
        expect(result).toContain('"writes"');
        expect(result).toContain("Selected clause");
    });

    it("ignores malformed modes and bounds the selection preview", () => {
        const result = buildContextSuffix({
            editMode: "replace_everything",
            creationMode: "download",
            selection: { has_selection: true, text: "x".repeat(800) },
        });

        expect(result).not.toContain("replace_everything");
        expect(result).not.toContain("download");
        expect(result.length).toBeLessThan(800);
        expect(result).toContain("...");
    });
});
