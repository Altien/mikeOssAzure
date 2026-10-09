import { describe, expect, it } from "vitest";
import { isWordQuickActionWorkflow } from "../../../word-addin/src/taskpane/lib/quickActions";

describe("Word quick-action workflows", () => {
    it("excludes Compare Documents by its stable default key after a rename", () => {
        expect(
            isWordQuickActionWorkflow({
                default_key: "compare-documents",
                metadata: { title: "My comparison" },
            }),
        ).toBe(false);
    });

    it("uses the title as a fallback and allows other workflows", () => {
        expect(
            isWordQuickActionWorkflow({
                metadata: { title: "Compare Documents" },
            }),
        ).toBe(false);
        expect(
            isWordQuickActionWorkflow({
                default_key: "proofread",
                metadata: { title: "Review drafting" },
            }),
        ).toBe(true);
    });
});
