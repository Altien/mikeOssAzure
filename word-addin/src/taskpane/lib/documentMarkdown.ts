// Structure-annotated markdown rendering of the active Word document.
//
// The add-in sends the document to Mike as `document_context`. A flat
// `body.text` loses everything Word knows about structure — headings, list
// nesting, tables — so the model reads a contract's clause hierarchy as an
// undifferentiated wall of text and a table as run-together cells.
//
// This renderer adds structure WITHOUT changing the text itself, because two
// downstream contracts depend on the model quoting document text verbatim:
// edit blocks (deleted_text is located with Word's search API) and citations
// (clicked quotes are located the same way). Every rule here is therefore
// additive-only:
//   - heading paragraphs gain a leading "# " marker (never inline emphasis —
//     `**bold**` would teach the model to quote characters that exist
//     nowhere in the document);
//   - list items gain their list marker and indentation;
//   - tables are rendered as pipe tables from their cell values.
// The paragraph/cell text between the markers stays byte-identical to what
// Word.search can find, and stripStructuralMarkers() undoes exactly these
// markers when a model quotes one anyway.

export type DocumentBlock =
  | {
      kind: "paragraph";
      text: string;
      /** Word.Style built-in name, e.g. "Heading1", "Title", "Normal". */
      styleBuiltIn?: string;
      /** The list label Word renders, e.g. "1." or "•". */
      listString?: string;
      /** 0-based list nesting level. */
      listLevel?: number;
    }
  | { kind: "table"; values: string[][] };

const HEADING_LEVEL_BY_STYLE: Record<string, number> = {
  Title: 1,
  Heading1: 1,
  Heading2: 2,
  Heading3: 3,
  Heading4: 4,
  Heading5: 5,
  Heading6: 6,
};

/** Word reports paragraph/cell text with host-dependent trailing breaks. */
function stripTrailingBreaks(text: string): string {
  return text.replace(/[\r\n\v]+$/g, "");
}

/** "1." / "a)" style labels render as themselves; bullet glyphs become "-". */
function listMarker(listString: string | undefined): string {
  if (listString && /^[0-9A-Za-z]{1,4}[.)]$/.test(listString)) {
    return listString;
  }
  return "-";
}

function renderTable(values: string[][]): string[] {
  const rows = values.map(
    (cells) =>
      `| ${cells
        .map((cell) =>
          // Newlines inside a cell would break the row line. Multi-line cell
          // passages are unsearchable for edits anyway (Word.search rejects
          // paragraph breaks), so flattening loses nothing locatable.
          stripTrailingBreaks(cell).replace(/[\r\n\v]+/g, " "),
        )
        .join(" | ")} |`,
  );
  const [headerRow, ...bodyRows] = rows;
  if (headerRow === undefined) return [];
  const columns = values[0]?.length ?? 1;
  const separator = `|${Array.from({ length: columns }, () => " --- ").join("|")}|`;
  return [headerRow, separator, ...bodyRows];
}

export function renderDocumentMarkdown(blocks: DocumentBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === "table") {
      // Pipe tables need blank-line separation to parse as tables.
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(...renderTable(block.values));
      lines.push("");
      continue;
    }
    const text = stripTrailingBreaks(block.text);
    const headingLevel = block.styleBuiltIn
      ? HEADING_LEVEL_BY_STYLE[block.styleBuiltIn]
      : undefined;
    if (headingLevel !== undefined && text.trim()) {
      lines.push(`${"#".repeat(headingLevel)} ${text}`);
      continue;
    }
    if (block.listString !== undefined) {
      const indent = "  ".repeat(Math.max(0, block.listLevel ?? 0));
      lines.push(`${indent}${listMarker(block.listString)} ${text}`);
      continue;
    }
    lines.push(text);
  }
  return lines.join("\n");
}

/**
 * Undo the renderer's structural markers from a model-quoted passage.
 *
 * The prompt tells the model that heading marks, list markers, and table
 * pipes are annotations, not document text — but a model quoting a heading
 * line sometimes copies them anyway. This strips exactly what
 * renderDocumentMarkdown adds (leading indent + one heading/list marker, or
 * single-cell pipe framing) so callers can retry a failed verbatim search.
 * Returns null when nothing was stripped, so callers never re-search the
 * same string.
 */
export function stripStructuralMarkers(quoted: string): string | null {
  let text = quoted;
  const framedCell = /^\s*\|(.*)\|\s*$/.exec(text)?.[1];
  if (framedCell !== undefined && !framedCell.includes("|")) {
    // "| cell text |" — a single-cell quote. Multi-cell quotes span cell
    // boundaries and are unlocatable regardless.
    text = framedCell.trim();
  }
  const unindented = text.replace(/^\s+/, "");
  // At most ONE marker layer: the renderer never stacks a heading mark and a
  // list marker on the same line, so stripping both in sequence would eat
  // document text (e.g. "# 1. Introduction" → "Introduction" when the "1."
  // is a manually typed number that IS in the document).
  const marker = /^(?:#{1,6} |[-*] |[0-9A-Za-z]{1,4}[.)] )/.exec(unindented);
  text = marker ? unindented.slice(marker[0].length) : unindented;
  return text === quoted ? null : text;
}
