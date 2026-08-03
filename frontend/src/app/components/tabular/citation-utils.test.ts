import { describe, expect, it } from "vitest";
import { preprocessCitations } from "./citation-utils";

describe("preprocessCitations", () => {
    it("parses a source-aware page citation", () => {
        const result = preprocessCitations(
            "Value [[document:doc-2||page:4||quote:Exact language]]",
        );

        expect(result.processed).toBe("Value §0§");
        expect(result.citations).toEqual([
            {
                documentId: "doc-2",
                page: 4,
                quote: "Exact language",
            },
        ]);
    });

    // Upstream divergence (sync-log: 6ae1f98d): spreadsheet (sheet/cell)
    // citations are not parsed — the excel/ppt viewer stack is deferred
    // (KNOWLEDGE §5 frontend refactor), so upstream's spreadsheet case is dropped.

    it("keeps legacy page citations compatible", () => {
        const result = preprocessCitations(
            "Value [[page:2||quote:Legacy language]]",
        );

        expect(result.citations).toEqual([
            {
                documentId: undefined,
                page: 2,
                quote: "Legacy language",
            },
        ]);
    });
});
