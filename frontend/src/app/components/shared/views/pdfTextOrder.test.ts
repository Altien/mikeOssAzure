import { describe, expect, it } from "vitest";
import { orderTextItemLines, type TextItemGeometry } from "./pdfTextOrder";
import sharedCases from "../../../../../../packages/pdf-text-order/cases.json";

// These cases are shared with the extractor's mirrored implementation in
// `backend/src/lib/pdfTextOrder.ts`. Both suites read the same file so the two
// copies cannot drift apart silently. See
// `packages/pdf-text-order/README.md`.
type SharedCase = {
    name: string;
    note?: string;
    items: TextItemGeometry[];
    expectedLines: number[][];
};

describe("orderTextItemLines (shared cases)", () => {
    const cases = sharedCases.cases as SharedCase[];

    it("covers the shared conformance suite", () => {
        expect(cases.length).toBeGreaterThan(0);
    });

    for (const testCase of cases) {
        it(testCase.name, () => {
            expect(orderTextItemLines(testCase.items)).toEqual(
                testCase.expectedLines,
            );
        });
    }
});
