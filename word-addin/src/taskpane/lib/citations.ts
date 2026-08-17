/**
 * Document citations in assistant prose.
 *
 * The Word-chat system prompt asks the model to wrap short verbatim quotes of
 * the active document in <cite>...</cite>. This module projects those markers
 * into Markdown links with a reserved fragment href, so the shared renderer
 * can style them as citation chips and a click can be routed to Word (search,
 * scroll, select) without ever showing the raw tags — even mid-stream, when a
 * tag may have arrived only partially.
 */

export const CITATION_HREF_PREFIX = "#mike-cite:";

const CITE_OPEN = "<cite>";
const CITE_CLOSE = "</cite>";

/** Longest prefix of `tag` that the text ends with (an unfinished marker). */
function partialTagStartAtEnd(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let length = tag.length - 1; length >= 1; length -= 1) {
    if (lower.endsWith(tag.slice(0, length))) return text.length - length;
  }
  return -1;
}

/** Escape the quote for use as a Markdown link label. */
function escapeLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

/** Encode the quote for the link target; () must not break Markdown links. */
function encodeCitationTarget(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function decodeCitationHref(href: string): string | null {
  if (!href.startsWith(CITATION_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(CITATION_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

/** The verbatim quote behind one of the backend's `[n]` citation markers. */
export interface CitationQuoteSource {
  marker?: string | null;
  quote?: string | null;
  text?: string | null;
}

/** Map "[n]" -> verbatim quote for every citation that carries one. */
function quotesByMarker(
  citations: readonly CitationQuoteSource[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [index, citation] of (citations ?? []).entries()) {
    const quote = (citation.quote ?? citation.text ?? "").trim();
    if (!quote) continue;
    const marker =
      typeof citation.marker === "string" && /^\[\d+\]$/.test(citation.marker)
        ? citation.marker
        : `[${index + 1}]`;
    if (!map.has(marker)) map.set(marker, quote);
  }
  return map;
}

/**
 * Replace citation markers with clickable links.
 *
 * Two sources feed this: the backend chat pipeline's native `[n]` markers
 * (resolved against the message's citations array, which carries each
 * marker's verbatim quote) and literal <cite>...</cite> tags. Incomplete
 * trailing tags are hidden; an opened-but-unclosed cite renders its inner
 * text as plain prose so streaming never flashes raw markup.
 */
export function projectCitationMarkdown(
  prose: string,
  citations?: readonly CitationQuoteSource[],
): string {
  const markers = quotesByMarker(citations);
  const withMarkers =
    markers.size === 0
      ? prose
      : prose.replace(/\[(\d+)\]/g, (match) => {
          const quote = markers.get(match);
          if (!quote) return match;
          return `[${escapeLinkLabel(match)}](${CITATION_HREF_PREFIX}${encodeCitationTarget(quote)})`;
        });
  return projectCiteTags(withMarkers);
}

function projectCiteTags(prose: string): string {
  let out = "";
  let cursor = 0;
  const lower = prose.toLowerCase();

  for (;;) {
    const open = lower.indexOf(CITE_OPEN, cursor);
    if (open < 0) break;
    out += prose.slice(cursor, open);
    const valueStart = open + CITE_OPEN.length;
    const close = lower.indexOf(CITE_CLOSE, valueStart);
    if (close < 0) {
      // Unclosed: show the text, minus any partially-arrived closing tag.
      let tail = prose.slice(valueStart);
      const partialClose = partialTagStartAtEnd(tail, CITE_CLOSE);
      if (partialClose >= 0) tail = tail.slice(0, partialClose);
      return out + tail;
    }
    const quote = prose.slice(valueStart, close).trim();
    if (quote) {
      out += `[${escapeLinkLabel(quote)}](${CITATION_HREF_PREFIX}${encodeCitationTarget(quote)})`;
    }
    cursor = close + CITE_CLOSE.length;
  }

  let tail = prose.slice(cursor);
  const partialOpen = partialTagStartAtEnd(tail, CITE_OPEN);
  if (partialOpen >= 0) tail = tail.slice(0, partialOpen);
  return out + tail;
}
