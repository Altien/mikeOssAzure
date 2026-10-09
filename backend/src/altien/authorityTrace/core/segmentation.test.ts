import { describe, expect, it } from "vitest";
import { segmentText } from "./segmentation";

describe("segmentText", () => {
  it("preserves the complete raw text", () => {
    const raw = "Before cited passage after.";
    const segments = segmentText(raw, [
      { citation_id: "c001", start: 7, end: 20 },
    ]);

    expect(segments.map((segment) => segment.text).join("")).toBe(raw);
    expect(segments).toEqual([
      { text: "Before ", highlights: [] },
      { text: "cited passage", highlights: ["c001"] },
      { text: " after.", highlights: [] },
    ]);
  });

  it("represents overlapping anchors without losing or duplicating text", () => {
    const raw = "0123456789";
    const segments = segmentText(raw, [
      { citation_id: "c001", start: 2, end: 7 },
      { citation_id: "c002", start: 5, end: 9 },
    ]);

    expect(segments.map((segment) => segment.text).join("")).toBe(raw);
    expect(segments).toEqual([
      { text: "01", highlights: [] },
      { text: "234", highlights: ["c001"] },
      { text: "56", highlights: ["c001", "c002"] },
      { text: "78", highlights: ["c002"] },
      { text: "9", highlights: [] },
    ]);
  });

  it("ignores invalid spans and handles empty documents", () => {
    expect(
      segmentText("text", [
        { citation_id: "c001", start: -1, end: 2 },
        { citation_id: "c002", start: 2, end: 10 },
      ]),
    ).toEqual([{ text: "text", highlights: [] }]);
    expect(segmentText("", [])).toEqual([{ text: "", highlights: [] }]);
  });
});
