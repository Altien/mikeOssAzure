/**
 * Parse model-proposed edits out of a streamed completion so they can be
 * applied to the document as tracked changes.
 *
 * The Proofread and Anonymise prompts instruct the model to report each issue
 * as an ORIGINAL / REPLACEMENT / REASON block. That format is deliberately
 * dual-purpose: it stays readable while it streams into the result box, and
 * once the stream finishes it parses into exact string edits that
 * `applyTrackedEdits` can locate in the document with Word's search API.
 */

// Shared contract for edits Mike must be able to apply automatically: the
// parser below and the Word search in applyTrackedEdits both depend on
// ORIGINAL being a verbatim, single-paragraph snippet.
export const REDLINE_FORMAT = `Report each item in exactly this format, with one blank line between items:

ORIGINAL: <text copied character-for-character from the document — a contiguous snippet from a single paragraph, under 200 characters>
REPLACEMENT: <the new text>
REASON: <one short sentence>

Copy ORIGINAL exactly (including capitalisation and punctuation) so the change can be applied to the document automatically.`;

export interface RedlineEdit {
  /** Exact text to locate in the document (verbatim, case-sensitive). */
  original: string;
  /** Text to put in its place. */
  replacement: string;
  /** Model's one-line justification; display-only. */
  reason?: string;
}

type FieldName = "original" | "replacement" | "reason";

// Tolerates list numbering ("1. ORIGINAL:") and Markdown bold ("**ORIGINAL:**")
// in case the model decorates the mandated format.
const FIELD_LINE = /^\s*(?:\d+[.)]\s*)?\*{0,2}(ORIGINAL|REPLACEMENT|REASON)\*{0,2}\s*:\s*(.*)$/;

export function parseRedlineEdits(text: string): RedlineEdit[] {
  const edits: RedlineEdit[] = [];
  const seenOriginals = new Set<string>();
  let current: Partial<Record<FieldName, string>> | null = null;
  let lastField: FieldName | null = null;

  const flush = (): void => {
    const original = current?.original?.trim();
    const replacement = current?.replacement;
    // A block is only actionable once both sides exist. Re-applying a repeated
    // ORIGINAL would fail its search after the first replacement, so dedupe.
    if (original && replacement !== undefined && !seenOriginals.has(original)) {
      seenOriginals.add(original);
      const reason = current?.reason?.trim();
      edits.push({
        original,
        replacement: replacement.trim(),
        ...(reason ? { reason } : {}),
      });
    }
    current = null;
    lastField = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(FIELD_LINE);
    if (match) {
      const field = match[1].toLowerCase() as FieldName;
      if (field === "original") flush();
      current ??= {};
      current[field] = match[2];
      lastField = field;
    } else if (!line.trim()) {
      // Blank line ends any multi-line field value.
      lastField = null;
    } else if (current && lastField) {
      // Continuation of a multi-line field value.
      current[lastField] = `${current[lastField] ?? ""}\n${line.trim()}`;
    }
  }
  flush();

  return edits;
}
