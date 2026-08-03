"use client";

// Optional `document:<id>||` prefix identifies the source document inside a
// folder-grouped row (upstream 6ae1f98d). Spreadsheet (sheet/cell) citations
// are not parsed: dev's spreadsheet viewer stack is deferred (KNOWLEDGE §5).
const PAGE_CITATION_RE =
    /\[\[(?:document:([^|\]]+)\|\|)?page:(\d+)\|\|(?:quote:)?((?:[^\[\]]|\[[^\]]*\])+)\]\]/gi;

export interface ParsedCitation {
    documentId?: string;
    page: number;
    quote: string;
}

/**
 * Replaces [[page:n||quote:...]] markers with `§idx§` placeholders.
 * Returns the processed string and an ordered array of extracted citation data.
 */
export function preprocessCitations(text: string): {
    processed: string;
    citations: ParsedCitation[];
} {
    const citations: ParsedCitation[] = [];
    PAGE_CITATION_RE.lastIndex = 0;
    const processed = text.replace(
        PAGE_CITATION_RE,
        (_, documentId: string | undefined, page: string, quote: string) => {
            const idx = citations.length;
            citations.push({
                documentId: documentId?.trim() || undefined,
                page: parseInt(page, 10),
                quote: quote.trim(),
            });
            return `§${idx}§`;
        },
    );
    return { processed, citations };
}
