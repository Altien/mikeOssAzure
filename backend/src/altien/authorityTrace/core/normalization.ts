export type MatchTier = "exact" | "normalized" | "hyphenless";

export type MatchWarning =
  | "multiple_matches"
  | "short_passage"
  | "source_header_match";

export type MatchFailureReason =
  | "not_found"
  | "case_mismatch"
  | "segment_too_short"
  | "ellipsis_gap_too_large"
  | "ellipsis_out_of_order";

export type NormalizedPosition = {
  start: number;
  end: number;
  lineBreak: boolean;
};

export type NormalizedText = {
  text: string;
  positions: NormalizedPosition[];
};

export type PassageMatch = {
  start: number;
  end: number;
  quote: string;
  match: MatchTier;
  warnings: MatchWarning[];
};

export type PassageMatchResult =
  | {
      ok: true;
      matches: PassageMatch[];
    }
  | {
      ok: false;
      reason: MatchFailureReason;
    };

const COMMON_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: "\u00a0",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
};

const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/u;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/u;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const ELLIPSIS_SPLIT = /\s*(?:\u2026|\.{3})\s*/u;

export const MIN_ELLIPSIS_SEGMENT_LENGTH = 8;
export const MAX_ELLIPSIS_GAP = 2_000;
export const MAX_MATCH_CANDIDATES = 1_000;
const SHORT_PASSAGE_LENGTH = 20;
const SOURCE_HEADER_LIMIT = 500;

type RawToken = {
  value: string;
  start: number;
  end: number;
};

function decodeEntity(entity: string): string | null {
  const body = entity.slice(1, -1);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const value = Number.parseInt(body.slice(2), 16);
    return validEntityCodePoint(value) ? String.fromCodePoint(value) : null;
  }
  if (body.startsWith("#")) {
    const value = Number.parseInt(body.slice(1), 10);
    return validEntityCodePoint(value) ? String.fromCodePoint(value) : null;
  }
  return COMMON_ENTITIES[body] ?? null;
}

function validEntityCodePoint(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

function entityAwareTokens(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  for (let index = 0; index < raw.length; ) {
    if (raw[index] === "&") {
      const candidate = raw.slice(index).match(/^&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);/u);
      if (candidate) {
        const decoded = decodeEntity(candidate[0]);
        if (decoded !== null) {
          tokens.push({
            value: decoded,
            start: index,
            end: index + candidate[0].length,
          });
          index += candidate[0].length;
          continue;
        }
      }
    }

    const codePoint = raw.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    tokens.push({ value, start: index, end: index + value.length });
    index += value.length;
  }
  return tokens;
}

function ignoredRanges(raw: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const patterns = [
    /<<pg\.\s*\d+>>/giu,
    /^[ \t]*>[ \t]?/gmu,
    /\[\^[^\]\r\n]+\]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const start = match.index;
      ranges.push({ start, end: start + match[0].length });
    }
  }

  // A word split only for layout is matched as one word.
  const dehyphenation = /[\p{L}\p{N}]-\r?\n(?=[\p{L}\p{N}])/gu;
  for (const match of raw.matchAll(dehyphenation)) {
    const start = match.index + match[0].search(/-\r?\n/u);
    ranges.push({ start, end: match.index + match[0].length });
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function isIgnored(
  token: RawToken,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some(
    (range) => token.start >= range.start && token.end <= range.end,
  );
}

function folded(value: string): string {
  if (DASHES.test(value)) return "-";
  if (SINGLE_QUOTES.test(value)) return "'";
  if (DOUBLE_QUOTES.test(value)) return '"';
  if (value === "…") return "...";
  return value.normalize("NFKC");
}

/**
 * Produces deterministic matching text and a map from every normalized
 * UTF-16 code unit back to the raw source span that created it.
 */
export function normalizeWithPositions(raw: string): NormalizedText {
  const positions: NormalizedPosition[] = [];
  let text = "";
  const ranges = ignoredRanges(raw);
  let whitespace:
    | { start: number; end: number; lineBreak: boolean }
    | undefined;

  const append = (
    value: string,
    start: number,
    end: number,
    lineBreak = false,
  ) => {
    text += value;
    for (let index = 0; index < value.length; index += 1) {
      positions.push({ start, end, lineBreak });
    }
  };
  const flushWhitespace = () => {
    if (!whitespace || text.length === 0) {
      whitespace = undefined;
      return;
    }
    append(
      " ",
      whitespace.start,
      whitespace.end,
      whitespace.lineBreak,
    );
    whitespace = undefined;
  };

  for (const token of entityAwareTokens(raw)) {
    if (isIgnored(token, ranges) || FORMAT_CHARACTER.test(token.value)) {
      continue;
    }
    if (/^\s+$/u.test(token.value)) {
      whitespace = whitespace
        ? {
            start: whitespace.start,
            end: token.end,
            lineBreak:
              whitespace.lineBreak || /[\r\n\u2028\u2029]/u.test(token.value),
          }
        : {
            start: token.start,
            end: token.end,
            lineBreak: /[\r\n\u2028\u2029]/u.test(token.value),
          };
      continue;
    }
    flushWhitespace();
    const normalized = folded(token.value);
    append(normalized, token.start, token.end);
  }

  // Trailing layout whitespace is immaterial for matching.
  return { text, positions };
}

export function hyphenless(normalized: NormalizedText): NormalizedText {
  let text = "";
  const positions: NormalizedPosition[] = [];
  for (let index = 0; index < normalized.text.length; index += 1) {
    const value = normalized.text[index];
    if (
      value === "-" &&
      index > 0 &&
      index + 1 < normalized.text.length &&
      ALPHANUMERIC.test(normalized.text[index - 1]) &&
      ALPHANUMERIC.test(normalized.text[index + 1])
    ) {
      continue;
    }
    text += value;
    positions.push(normalized.positions[index]);
  }
  return { text, positions };
}

function allIndices(
  haystack: string,
  needle: string,
  from = 0,
  limit = MAX_MATCH_CANDIDATES,
): number[] {
  if (!needle) return [];
  const indices: number[] = [];
  let cursor = Math.max(0, from);
  while (indices.length < limit) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    indices.push(found);
    cursor = found + Math.max(1, needle.length);
  }
  return indices;
}

function warningsFor(
  raw: string,
  normalizedLength: number,
  matches: Array<{ start: number }>,
): MatchWarning[] {
  const warnings: MatchWarning[] = [];
  if (matches.length > 1) warnings.push("multiple_matches");
  if (normalizedLength < SHORT_PASSAGE_LENGTH) warnings.push("short_passage");
  const firstBlankLine = raw.search(/\r?\n[ \t]*\r?\n/u);
  const headerEnd =
    firstBlankLine >= 0 && firstBlankLine <= SOURCE_HEADER_LIMIT
      ? firstBlankLine
      : 0;
  if (matches[0] && headerEnd > 0 && matches[0].start < headerEnd) {
    warnings.push("source_header_match");
  }
  return warnings;
}

function mappedMatches(
  raw: string,
  normalized: NormalizedText,
  indices: number[],
  needleLength: number,
  match: MatchTier,
  queryLength: number,
): PassageMatch[] {
  const spans = indices.flatMap((index) => {
    const first = normalized.positions[index];
    const last = normalized.positions[index + needleLength - 1];
    if (!first || !last) return [];
    return [{ start: first.start, end: last.end }];
  });
  const warnings = warningsFor(raw, queryLength, spans);
  return spans.map((span) => ({
    ...span,
    quote: raw.slice(span.start, span.end),
    match,
    warnings,
  }));
}

export function findPlainPassageMatches(
  raw: string,
  proposed: string,
): PassageMatchResult {
  if (!proposed) return { ok: false, reason: "not_found" };

  const exactIndices = allIndices(raw, proposed);
  if (exactIndices.length > 0) {
    const normalizedLength = normalizeWithPositions(proposed).text.length;
    const spans = exactIndices.map((start) => ({
      start,
      end: start + proposed.length,
    }));
    const warnings = warningsFor(raw, normalizedLength, spans);
    return {
      ok: true,
      matches: spans.map((span) => ({
        ...span,
        quote: raw.slice(span.start, span.end),
        match: "exact",
        warnings,
      })),
    };
  }

  const normalizedRaw = normalizeWithPositions(raw);
  const normalizedProposed = normalizeWithPositions(proposed);
  if (!normalizedProposed.text) return { ok: false, reason: "not_found" };
  const normalizedIndices = allIndices(
    normalizedRaw.text,
    normalizedProposed.text,
  );
  if (normalizedIndices.length > 0) {
    return {
      ok: true,
      matches: mappedMatches(
        raw,
        normalizedRaw,
        normalizedIndices,
        normalizedProposed.text.length,
        "normalized",
        normalizedProposed.text.length,
      ),
    };
  }

  const hyphenlessRaw = hyphenless(normalizedRaw);
  const hyphenlessProposed = hyphenless(normalizedProposed);
  const hyphenlessIndices = allIndices(
    hyphenlessRaw.text,
    hyphenlessProposed.text,
  );
  if (hyphenlessIndices.length > 0) {
    return {
      ok: true,
      matches: mappedMatches(
        raw,
        hyphenlessRaw,
        hyphenlessIndices,
        hyphenlessProposed.text.length,
        "hyphenless",
        hyphenlessProposed.text.length,
      ),
    };
  }

  if (
    normalizedRaw.text.toLocaleLowerCase() ===
      normalizedProposed.text.toLocaleLowerCase() ||
    normalizedRaw.text
      .toLocaleLowerCase()
      .includes(normalizedProposed.text.toLocaleLowerCase())
  ) {
    return { ok: false, reason: "case_mismatch" };
  }
  return { ok: false, reason: "not_found" };
}

export function findPassageMatches(
  raw: string,
  proposed: string,
): PassageMatchResult {
  const segments = proposed.split(ELLIPSIS_SPLIT);
  if (segments.length === 1) {
    return findPlainPassageMatches(raw, proposed);
  }

  const normalizedSegments = segments.map(
    (segment) => normalizeWithPositions(segment).text,
  );
  if (
    normalizedSegments.some(
      (segment) => segment.length < MIN_ELLIPSIS_SEGMENT_LENGTH,
    )
  ) {
    return { ok: false, reason: "segment_too_short" };
  }

  const selected: PassageMatch[] = [];
  let previousEnd = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const result = findPlainPassageMatches(raw, segments[index]);
    if (!result.ok) return result;
    const ordered = result.matches.find((match) => match.start >= previousEnd);
    if (!ordered) {
      return { ok: false, reason: "ellipsis_out_of_order" };
    }
    if (
      index > 0 &&
      ordered.start - previousEnd > MAX_ELLIPSIS_GAP
    ) {
      return { ok: false, reason: "ellipsis_gap_too_large" };
    }
    selected.push(ordered);
    previousEnd = ordered.end;
  }
  return { ok: true, matches: selected };
}
