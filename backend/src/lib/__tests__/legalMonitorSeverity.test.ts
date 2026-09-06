import { describe, expect, it } from "vitest";
import {
  meetsSeverityThreshold,
  normalizeSeverity,
  parseAnalysis,
  sortDevelopmentsBySeverity,
  type LegalMonitorDevelopment,
} from "../legalMonitors";

function development(
  overrides: Partial<LegalMonitorDevelopment> = {},
): LegalMonitorDevelopment {
  return {
    title: "A development",
    type: "regulatory",
    date: null,
    url: null,
    citation: null,
    sourceName: null,
    whyItMatters: "",
    severity: "medium",
    confidence: null,
    unverified: [],
    ...overrides,
  };
}

describe("normalizeSeverity", () => {
  it("accepts the four graded levels", () => {
    for (const level of ["critical", "high", "medium", "low"] as const) {
      expect(normalizeSeverity(level)).toBe(level);
    }
  });

  it("falls back to medium for anything unscored or unrecognised", () => {
    expect(normalizeSeverity(undefined)).toBe("medium");
    expect(normalizeSeverity("URGENT")).toBe("medium");
    expect(normalizeSeverity(3)).toBe("medium");
    expect(normalizeSeverity(null)).toBe("medium");
  });
});

describe("meetsSeverityThreshold", () => {
  it("passes anything at or above the threshold", () => {
    expect(meetsSeverityThreshold("critical", "high")).toBe(true);
    expect(meetsSeverityThreshold("high", "high")).toBe(true);
  });

  it("holds back anything below it", () => {
    expect(meetsSeverityThreshold("medium", "high")).toBe(false);
    expect(meetsSeverityThreshold("low", "medium")).toBe(false);
  });

  it("passes everything at the default 'low' threshold", () => {
    for (const level of ["critical", "high", "medium", "low"] as const) {
      expect(meetsSeverityThreshold(level, "low")).toBe(true);
    }
  });
});

describe("sortDevelopmentsBySeverity", () => {
  it("puts the most urgent development first", () => {
    const sorted = sortDevelopmentsBySeverity([
      development({ title: "c", severity: "low" }),
      development({ title: "a", severity: "critical" }),
      development({ title: "b", severity: "medium" }),
    ]);
    expect(sorted.map((item) => item.title)).toEqual(["a", "b", "c"]);
  });

  it("keeps the model's ordering within a severity", () => {
    const sorted = sortDevelopmentsBySeverity([
      development({ title: "first", severity: "high" }),
      development({ title: "second", severity: "high" }),
    ]);
    expect(sorted.map((item) => item.title)).toEqual(["first", "second"]);
  });
});

describe("parseAnalysis severity handling", () => {
  it("reads severity and confidence, and ranks the result", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        summary: "Two developments.",
        hasMaterialUpdates: true,
        report: "## Report",
        developments: [
          { title: "Guidance note", severity: "low", confidence: 0.4 },
          { title: "Final rule", severity: "critical", confidence: 0.95 },
        ],
      }),
    );

    expect(parsed.developments.map((item) => item.title)).toEqual([
      "Final rule",
      "Guidance note",
    ]);
    expect(parsed.developments[0].severity).toBe("critical");
    expect(parsed.developments[0].confidence).toBe(0.95);
  });

  it("scores an unscored development medium rather than dropping it", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        summary: "One development.",
        hasMaterialUpdates: true,
        report: "## Report",
        developments: [{ title: "Unscored" }],
      }),
    );
    expect(parsed.developments).toHaveLength(1);
    expect(parsed.developments[0].severity).toBe("medium");
    expect(parsed.developments[0].confidence).toBeNull();
  });

  it("clamps a confidence the model returned out of range", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        summary: "s",
        hasMaterialUpdates: true,
        report: "r",
        developments: [
          { title: "over", confidence: 4 },
          { title: "under", confidence: -1 },
        ],
      }),
    );
    expect(parsed.developments.map((item) => item.confidence)).toEqual([1, 0]);
  });

  it("still starts every development unverified-clean", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        summary: "s",
        hasMaterialUpdates: true,
        report: "r",
        developments: [{ title: "x", severity: "high" }],
      }),
    );
    expect(parsed.developments[0].unverified).toEqual([]);
  });
});
