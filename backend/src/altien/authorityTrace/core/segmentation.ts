export type TextHighlight = {
  citation_id: string;
  start: number;
  end: number;
};

export type TextSegment = {
  text: string;
  highlights: string[];
};

/**
 * Splits complete raw text at server-verified UTF-16 boundaries. Overlapping
 * highlights are represented by multiple citation ids on the same segment.
 */
export function segmentText(
  raw: string,
  highlights: TextHighlight[],
): TextSegment[] {
  const valid = highlights.filter(
    (highlight) =>
      Number.isSafeInteger(highlight.start) &&
      Number.isSafeInteger(highlight.end) &&
      highlight.start >= 0 &&
      highlight.end > highlight.start &&
      highlight.end <= raw.length,
  );
  const boundaries = Array.from(
    new Set([
      0,
      raw.length,
      ...valid.flatMap((highlight) => [highlight.start, highlight.end]),
    ]),
  ).sort((a, b) => a - b);

  const segments: TextSegment[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    const citationIds = valid
      .filter(
        (highlight) => highlight.start <= start && highlight.end >= end,
      )
      .map((highlight) => highlight.citation_id)
      .sort();
    const prior = segments.at(-1);
    if (
      prior &&
      prior.highlights.length === citationIds.length &&
      prior.highlights.every((value, i) => value === citationIds[i])
    ) {
      prior.text += raw.slice(start, end);
    } else {
      segments.push({
        text: raw.slice(start, end),
        highlights: citationIds,
      });
    }
  }
  if (raw.length === 0) return [{ text: "", highlights: [] }];
  return segments;
}
