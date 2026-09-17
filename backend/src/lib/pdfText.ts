import path from "path";

export const STANDARD_FONT_DATA_URL = (() => {
  try {
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
  } catch {
    return undefined;
  }
})();

import { docxToPdf } from "./convert";

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

/**
 * Rebuild a page's text from positioned pdfjs items, preserving the visual
 * layout: lines are reconstructed from y-coordinates, words
 * are joined (or split) based on measured x-gaps rather than a blanket
 * space, paragraph breaks become blank lines, and indentation is kept
 * relative to the page's left margin.
 */
function layoutPageText(items: PdfTextItem[]): string {
  type Item = {
    str: string;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  const clean: Item[] = [];
  for (const it of items) {
    const str = it.str ?? "";
    if (!str) continue;
    const t = Array.isArray(it.transform) ? it.transform : [];
    clean.push({
      str,
      x: typeof t[4] === "number" ? t[4] : 0,
      y: typeof t[5] === "number" ? t[5] : 0,
      w: typeof it.width === "number" ? it.width : 0,
      h:
        Math.abs(typeof t[3] === "number" ? t[3] : 0) ||
        (typeof it.height === "number" ? it.height : 0) ||
        10,
    });
  }
  if (!clean.length) return "";

  // Cluster by baseline before sorting each row by X. Content streams can
  // emit whole columns at a time, and hasEOL can end just one column's text.
  clean.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Item[][] = [];
  let cur: Item[] = [];
  let curY: number | null = null;
  let curH = 0;
  for (const it of clean) {
    if (curY === null || Math.abs(it.y - curY) > Math.max(2, curH * 0.5)) {
      cur = [];
      lines.push(cur);
      // Keep a fixed anchor so small baseline differences cannot chain
      // together and accidentally merge successive rows.
      curY = it.y;
      curH = it.h;
    }
    cur.push(it);
  }

  // Rows are already top-to-bottom (PDF y grows upward).
  for (const line of lines) line.sort((a, b) => a.x - b.x);

  const marginX = Math.min(...lines.map((line) => line[0]?.x ?? 0));

  const out: string[] = [];
  let prevY: number | null = null;
  let prevLineH: number | null = null;
  for (const line of lines) {
    const lineH = Math.max(...line.map((c) => c.h));

    // Paragraph break: a vertical gap well above the line height.
    if (prevY !== null && prevLineH !== null) {
      const vGap = Math.abs((line[0]?.y ?? 0) - prevY);
      if (vGap > prevLineH * 1.7) out.push("");
    }

    // Indentation relative to the page's left margin.
    const charW = Math.max(1, lineH * 0.5);
    const indent = Math.min(
      24,
      Math.max(0, Math.round(((line[0]?.x ?? 0) - marginX) / charW)),
    );

    let s = "";
    let prevEnd: number | null = null;
    for (const it of line) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        // Only insert a space for a real word gap — small kerning gaps
        // (e.g. "constitut" + "e") are joined without one.
        if (gap > lineH * 2.5) {
          // Preserve obvious columns (signature blocks and simple tables)
          // without exaggerating ordinary word spacing in justified text.
          s += " ".repeat(Math.min(16, Math.max(4, Math.round(gap / charW))));
        } else if (gap > lineH * 0.15) {
          // Common spaces are about 0.25em; leave room below that while
          // keeping zero/tiny kerning gaps joined.
          s += " ";
        }
      }
      s += it.str;
      prevEnd = it.x + it.w;
    }
    const trimmed = s.trimEnd();
    if (trimmed) out.push(" ".repeat(indent) + trimmed);
    prevY = line[0]?.y ?? prevY;
    prevLineH = lineH;
  }
  return out.join("\n");
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{
                items: PdfTextItem[];
              }>;
            }>;
          }>;
        };
      }
    ).getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      parts.push(`[Page ${i}]\n${layoutPageText(textContent.items)}`);
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The text read_document derives for the legacy Office types (.doc/.ppt):
 * LibreOffice → PDF → pdfjs. Exported so the document.precompute_text job
 * produces byte-identical text to the inline read path — a cache that can
 * drift from what it caches is worse than no cache.
 */
export async function extractLegacyOfficeText(
  raw: ArrayBuffer,
): Promise<string> {
  const pdfBuf = await docxToPdf(Buffer.from(raw));
  return extractPdfText(
    pdfBuf.buffer.slice(
      pdfBuf.byteOffset,
      pdfBuf.byteOffset + pdfBuf.byteLength,
    ) as ArrayBuffer,
  );
}
