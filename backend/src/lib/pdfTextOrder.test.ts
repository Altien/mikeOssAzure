import { describe, expect, it } from "vitest";
import { orderTextItemLines, type TextItemGeometry } from "./pdfTextOrder";
import sharedCases from "../../../packages/pdf-text-order/cases.json";

// These cases are shared with the web viewer's mirrored implementation in
// `frontend/src/app/components/shared/views/pdfTextOrder.ts`. Both suites read
// the same file so the two copies cannot drift apart silently. See
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

describe("orderTextItemLines", () => {
  it("reorders a column-drawn table into reading order", () => {
    // The regression this exists for: a quote reading across a table row has
    // to come back contiguous, or the viewer's substring search cannot find it.
    const items: TextItemGeometry[] = [
      { x: 72, y: 700, w: 40, h: 12 }, // "Name"
      { x: 72, y: 680, w: 40, h: 12 }, // "Alice"
      { x: 300, y: 700, w: 50, h: 12 }, // "Amount"
      { x: 300, y: 680, w: 40, h: 12 }, // "$100"
    ];

    expect(orderTextItemLines(items).flat()).toEqual([0, 2, 1, 3]);
  });
});
