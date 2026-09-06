import { describe, expect, it } from "vitest";
import {
  buildVerificationIndex,
  canonicalizeUrl,
  citationFingerprint,
  countUnverified,
  UNVERIFIED_CITATION,
  UNVERIFIED_URL,
  verifyDevelopments,
  type VerifiableSourceItem,
} from "../legalMonitorVerification";
import type { LegalMonitorDevelopment } from "../legalMonitors";

function development(
  overrides: Partial<LegalMonitorDevelopment> = {},
): LegalMonitorDevelopment {
  return {
    title: "SEC adopts amendments to Rule 10b5-1",
    type: "regulatory",
    date: "2026-08-14",
    url: "https://www.sec.gov/rules/final/2026/33-11138.htm",
    citation: "17 C.F.R. § 240.10b5-1",
    sourceName: "SEC",
    whyItMatters: "Changes insider trading plan requirements.",
    severity: "high",
    confidence: 0.8,
    unverified: [],
    ...overrides,
  };
}

const items: VerifiableSourceItem[] = [
  {
    url: "https://sec.gov/rules/final/2026/33-11138.htm/",
    title: "SEC adopts amendments",
    summary: "Final rule adopted.",
    content: "The Commission amended 17 CFR 240.10b5-1 effective January 2027.",
  },
];

describe("canonicalizeUrl", () => {
  it("ignores scheme, www, trailing slash and tracking parameters", () => {
    const forms = [
      "https://www.sec.gov/rules/final/2026/33-11138.htm",
      "http://sec.gov/rules/final/2026/33-11138.htm/",
      "https://sec.gov/rules/final/2026/33-11138.htm?utm_source=feed#section-2",
      "https://SEC.gov/Rules/Final/2026/33-11138.HTM",
    ];
    const canonical = forms.map(canonicalizeUrl);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe("sec.gov/rules/final/2026/33-11138.htm");
  });

  it("rejects anything that is not a fetchable http(s) URL", () => {
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("file:///etc/passwd")).toBeNull();
    expect(canonicalizeUrl("   ")).toBeNull();
  });
});

describe("citationFingerprint", () => {
  it("survives the punctuation and spacing lawyers actually vary", () => {
    expect(citationFingerprint("17 C.F.R. § 240.10b5-1")).toBe(
      citationFingerprint("17 CFR 240.10b51"),
    );
  });
});

describe("verifyDevelopments", () => {
  it("passes a development whose link and citation both appear in the sources", () => {
    const [verified] = verifyDevelopments([development()], items);
    expect(verified.unverified).toEqual([]);
  });

  it("flags a URL that was never fetched", () => {
    const [verified] = verifyDevelopments(
      [development({ url: "https://example.com/invented-rule" })],
      items,
    );
    expect(verified.unverified).toEqual([UNVERIFIED_URL]);
  });

  it("flags a citation that appears in no fetched content", () => {
    const [verified] = verifyDevelopments(
      [development({ citation: "29 C.F.R. § 1910.1200" })],
      items,
    );
    expect(verified.unverified).toEqual([UNVERIFIED_CITATION]);
  });

  it("flags both when the model invented the whole development", () => {
    const [verified] = verifyDevelopments(
      [
        development({
          url: "https://example.com/nope",
          citation: "42 U.S.C. § 1983",
        }),
      ],
      items,
    );
    expect(verified.unverified).toEqual([UNVERIFIED_URL, UNVERIFIED_CITATION]);
  });

  it("flags a malformed URL rather than silently accepting it", () => {
    const [verified] = verifyDevelopments(
      [development({ url: "sec.gov/rules" })],
      items,
    );
    expect(verified.unverified).toEqual([UNVERIFIED_URL]);
  });

  it("does not penalise a development that claims neither url nor citation", () => {
    const [verified] = verifyDevelopments(
      [development({ url: null, citation: null })],
      items,
    );
    expect(verified.unverified).toEqual([]);
  });

  it("ignores a citation too short to be evidence of anything", () => {
    const [verified] = verifyDevelopments(
      [development({ citation: "s 1" })],
      items,
    );
    expect(verified.unverified).toEqual([]);
  });

  it("keeps every development — marking is not dropping", () => {
    const verified = verifyDevelopments(
      [development(), development({ url: "https://example.com/nope" })],
      items,
    );
    expect(verified).toHaveLength(2);
    expect(countUnverified(verified)).toBe(1);
  });

  it("verifies nothing when no sources were fetched", () => {
    const [verified] = verifyDevelopments([development()], []);
    expect(verified.unverified).toEqual([
      UNVERIFIED_URL,
      UNVERIFIED_CITATION,
    ]);
  });
});

describe("buildVerificationIndex", () => {
  it("indexes every fetched item's url and searchable text", () => {
    const index = buildVerificationIndex(items);
    expect(index.urls.has("sec.gov/rules/final/2026/33-11138.htm")).toBe(true);
    expect(index.corpus).toContain(citationFingerprint("17 CFR 240.10b5-1"));
  });
});
