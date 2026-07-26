import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ELLIPSIS_GAP,
  findPassageMatches,
  findPlainPassageMatches,
  hyphenless,
  normalizeWithPositions,
} from "./normalization";

type SharedVector = {
  name: string;
  raw: string;
  normalized?: string;
  proposed?: string;
  match?: "exact" | "normalized" | "hyphenless";
  quote?: string;
};

const sharedVectors = (
  JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "../docs/altien/tests/authority-trace-normalization.json",
      ),
      "utf8",
    ),
  ) as { vectors: SharedVector[] }
).vectors;

describe("shared Authority Trace normalization vectors", () => {
  it.each(sharedVectors)("$name", (vector) => {
    if (vector.normalized !== undefined) {
      expect(normalizeWithPositions(vector.raw).text).toBe(
        vector.normalized,
      );
    }
    if (vector.proposed !== undefined) {
      const result = findPlainPassageMatches(
        vector.raw,
        vector.proposed,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches[0]).toMatchObject({
        match: vector.match,
        quote: vector.quote,
      });
      expect(
        vector.raw.slice(
          result.matches[0].start,
          result.matches[0].end,
        ),
      ).toBe(vector.quote);
    }
  });
});

describe("normalizeWithPositions", () => {
  it.each([
    ["A&amp;B &#8212; C", "A&B - C"],
    ["A&#x2019;B &unknown; C &#xD800;", "A'B &unknown; C &#xD800;"],
    ["A\u200bB\u2060C", "ABC"],
    ["ＡＢＣ ﬁ", "ABC fi"],
    ["“quoted”—‘yes’…", "\"quoted\"-'yes'..."],
    ["inter-\r\nnational", "international"],
    ["Before <<pg. 12>> after [^note]", "Before after"],
    ["> quoted\r\n> text", "quoted text"],
  ])("normalizes %j deterministically", (raw, expected) => {
    expect(normalizeWithPositions(raw).text).toBe(expected);
  });

  it("collapses whitespace while retaining whether it crossed a line", () => {
    const normalized = normalizeWithPositions("one \r\n\t two");
    expect(normalized.text).toBe("one two");
    expect(normalized.positions[3]).toMatchObject({ lineBreak: true });
  });

  it("keeps UTF-16 source positions after astral characters", () => {
    const raw = "😀 Ａ";
    const normalized = normalizeWithPositions(raw);
    const a = normalized.text.indexOf("A");

    expect(normalized.positions[a]).toMatchObject({
      start: raw.indexOf("Ａ"),
      end: raw.indexOf("Ａ") + 1,
    });
  });

  it("derives a mapped hyphenless representation", () => {
    const raw = "well-being";
    const result = hyphenless(normalizeWithPositions(raw));

    expect(result.text).toBe("wellbeing");
    expect(raw.slice(result.positions[0].start, result.positions.at(-1)?.end))
      .toBe(raw);
  });
});

describe("passage matching", () => {
  it("uses exact, normalized, then hyphenless tiers and returns raw slices", () => {
    const exactRaw = "Before exact words after";
    const normalizedRaw = "Before “quoted”\r\nwords after";
    const hyphenlessRaw = "The long-term outcome";

    const exact = findPlainPassageMatches(exactRaw, "exact words");
    const normalized = findPlainPassageMatches(
      normalizedRaw,
      '"quoted" words',
    );
    const withoutHyphen = findPlainPassageMatches(
      hyphenlessRaw,
      "longterm outcome",
    );

    expect(exact.ok && exact.matches[0]).toMatchObject({ match: "exact" });
    expect(normalized.ok && normalized.matches[0]).toMatchObject({
      match: "normalized",
      quote: "“quoted”\r\nwords",
    });
    expect(withoutHyphen.ok && withoutHyphen.matches[0]).toMatchObject({
      match: "hyphenless",
      quote: "long-term outcome",
    });
  });

  it("diagnoses case-only differences", () => {
    expect(findPlainPassageMatches("The Court Held", "the court held"))
      .toEqual({ ok: false, reason: "case_mismatch" });
  });

  it("chains bounded ellipsis segments in document order", () => {
    const raw = "first segment accepted " + "x".repeat(50) + " final segment accepted";
    const result = findPassageMatches(
      raw,
      "first segment accepted … final segment accepted",
    );

    expect(result.ok && result.matches).toHaveLength(2);
    if (result.ok) {
      expect(result.matches[0].end).toBeLessThan(result.matches[1].start);
    }
  });

  it("rejects short, reversed, and over-wide ellipsis segments", () => {
    expect(findPassageMatches("short then sufficiently long", "short … sufficiently long"))
      .toEqual({ ok: false, reason: "segment_too_short" });
    expect(
      findPassageMatches(
        "second segment accepted then first segment accepted",
        "first segment accepted … second segment accepted",
      ),
    ).toEqual({ ok: false, reason: "ellipsis_out_of_order" });
    expect(
      findPassageMatches(
        `first segment accepted ${"x".repeat(MAX_ELLIPSIS_GAP + 1)} final segment accepted`,
        "first segment accepted … final segment accepted",
      ),
    ).toEqual({ ok: false, reason: "ellipsis_gap_too_large" });
  });

  it("round-trips generated raw slices through every successful tier", () => {
    const prefixes = ["", "😀", "Header\r\n", "\u200b"];
    const variants = [
      ["The court adopted the rule.", "The court adopted the rule."],
      ["The court “adopted” the rule.", 'The court "adopted" the rule.'],
      ["The long-term rule applies.", "The longterm rule applies."],
    ] as const;

    for (const prefix of prefixes) {
      for (const [rawPassage, proposed] of variants) {
        const raw = `${prefix}${rawPassage} Tail`;
        const result = findPlainPassageMatches(raw, proposed);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        for (const match of result.matches) {
          expect(raw.slice(match.start, match.end)).toBe(match.quote);
        }
      }
    }
  });
});
