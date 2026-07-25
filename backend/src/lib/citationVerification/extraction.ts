import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { STANDARD_FONT_DATA_URL } from "../chat/types";

export type ExtractionWarning = "revisions_present" | "ocr_required";

export type VerificationExtraction = {
  markdown: string;
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/pdf";
  pageCount: number | null;
  warnings: ExtractionWarning[];
};

export const OCR_EMPTY_PAGE_RATIO = 0.5;

type XNode = Record<string, unknown>;
const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elementName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  for (const key of Object.keys(node as XNode)) {
    if (key !== ATTR_KEY && key !== TEXT_KEY) return key;
  }
  return null;
}

function children(node: unknown): XNode[] {
  const name = elementName(node);
  if (!name) return [];
  const value = (node as XNode)[name];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

function attributes(node: unknown): Record<string, string> {
  if (!node || typeof node !== "object") return {};
  return ((node as XNode)[ATTR_KEY] as Record<string, string>) ?? {};
}

function textNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = (node as XNode)[TEXT_KEY];
  return typeof value === "string" ? value : "";
}

function findFirst(nodes: XNode[], name: string): XNode | undefined {
  for (const node of nodes) {
    if (elementName(node) === name) return node;
    const nested = findFirst(children(node), name);
    if (nested) return nested;
  }
  return undefined;
}

function directChildren(node: XNode, name: string): XNode[] {
  return children(node).filter((child) => elementName(child) === name);
}

function xmlText(node: XNode, noteKind?: "fn" | "en"): string {
  const name = elementName(node);
  if (!name) return textNode(node);
  if (name === "w:del" || name === "w:moveFrom" || name === "w:delText") {
    return "";
  }
  if (name === "w:tab") return "\t";
  if (name === "w:br" || name === "w:cr") return "\n";
  if (name === "w:footnoteReference") {
    return `[^fn-${attributes(node)["@_w:id"] ?? "unknown"}]`;
  }
  if (name === "w:endnoteReference") {
    return `[^en-${attributes(node)["@_w:id"] ?? "unknown"}]`;
  }
  if (name === "w:footnoteRef" && noteKind === "fn") return "";
  if (name === "w:endnoteRef" && noteKind === "en") return "";
  return children(node).map((child) => xmlText(child, noteKind)).join("");
}

function paragraphStyle(paragraph: XNode): string | undefined {
  const style = findFirst(children(paragraph), "w:pStyle");
  return style ? attributes(style)["@_w:val"] : undefined;
}

function renderParagraph(
  paragraph: XNode,
  noteKind?: "fn" | "en",
): string {
  const text = xmlText(paragraph, noteKind)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
  if (!text) return "";
  const style = paragraphStyle(paragraph) ?? "";
  const heading = style.match(/^Heading\s*([1-6])$/iu);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text}`;
  if (/^Title$/iu.test(style)) return `# ${text}`;
  if (/^Subtitle$/iu.test(style)) return `## ${text}`;
  return text;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/gu, "<br>");
}

function renderTable(table: XNode, noteKind?: "fn" | "en"): string {
  const rows = directChildren(table, "w:tr").map((row) =>
    directChildren(row, "w:tc").map((cell) =>
      directChildren(cell, "w:p")
        .map((paragraph) => renderParagraph(paragraph, noteKind))
        .filter(Boolean)
        .map(escapeTableCell)
        .join("<br>"),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length), 1);
  const padded = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(padded[0]),
    line(Array.from({ length: width }, () => "---")),
    ...padded.slice(1).map(line),
  ].join("\n");
}

function renderBlocks(
  nodes: XNode[],
  noteKind?: "fn" | "en",
): string[] {
  return nodes.flatMap((node) => {
    const name = elementName(node);
    if (name === "w:p") {
      const rendered = renderParagraph(node, noteKind);
      return rendered ? [rendered] : [];
    }
    if (name === "w:tbl") {
      const rendered = renderTable(node, noteKind);
      return rendered ? [rendered] : [];
    }
    if (name === "w:sdt" || name === "w:sdtContent") {
      return renderBlocks(children(node), noteKind);
    }
    return [];
  });
}

function parser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    trimValues: false,
    parseAttributeValue: false,
    processEntities: true,
  });
}

async function zipText(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path) ?? zip.file(path.replaceAll("/", "\\"));
  return entry ? entry.async("string") : null;
}

function renderNotes(
  tree: XNode[],
  containerName: "w:footnotes" | "w:endnotes",
  noteName: "w:footnote" | "w:endnote",
  kind: "fn" | "en",
): string[] {
  const container = findFirst(tree, containerName);
  if (!container) return [];
  return directChildren(container, noteName).flatMap((note) => {
    const rawId = attributes(note)["@_w:id"];
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) return [];
    const body = renderBlocks(children(note), kind).join(" ").trim();
    return body ? [`[^${kind}-${id}]: ${body}`] : [];
  });
}

export async function extractDocxForVerification(
  bytes: Uint8Array,
): Promise<VerificationExtraction> {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zipText(zip, "word/document.xml");
  if (!documentXml) throw new Error("DOCX has no word/document.xml part");
  const xmlParser = parser();
  const documentTree = xmlParser.parse(documentXml) as XNode[];
  const body = findFirst(documentTree, "w:body");
  if (!body) throw new Error("DOCX document has no body");

  const footnotesXml = await zipText(zip, "word/footnotes.xml");
  const endnotesXml = await zipText(zip, "word/endnotes.xml");
  const footnotesTree = footnotesXml
    ? (xmlParser.parse(footnotesXml) as XNode[])
    : [];
  const endnotesTree = endnotesXml
    ? (xmlParser.parse(endnotesXml) as XNode[])
    : [];
  const blocks = renderBlocks(children(body));
  const footnotes = renderNotes(
    footnotesTree,
    "w:footnotes",
    "w:footnote",
    "fn",
  );
  const endnotes = renderNotes(
    endnotesTree,
    "w:endnotes",
    "w:endnote",
    "en",
  );
  if (footnotes.length > 0) {
    blocks.push("## Footnotes", ...footnotes);
  }
  if (endnotes.length > 0) {
    blocks.push("## Endnotes", ...endnotes);
  }

  const allXml = [documentXml, footnotesXml ?? "", endnotesXml ?? ""].join(
    "\n",
  );
  const revisionsPresent =
    /<w:(?:ins|del|moveFrom|moveTo)(?:\s|>)/u.test(allXml);
  const markdown = `${blocks.join("\n\n").trim()}\n`;
  return {
    markdown,
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pageCount: null,
    warnings: revisionsPresent ? ["revisions_present"] : [],
  };
}

export type PdfPageLoader = (
  bytes: Uint8Array,
) => Promise<{ pages: string[] }>;

async function loadPdfPages(bytes: Uint8Array): Promise<{ pages: string[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const document = await (
    pdfjs as unknown as {
      getDocument: (options: unknown) => {
        promise: Promise<{
          numPages: number;
          getPage: (page: number) => Promise<{
            getTextContent: () => Promise<{
              items: Array<{ str?: string; hasEOL?: boolean }>;
            }>;
          }>;
        }>;
      };
    }
  ).getDocument({
    data: bytes,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      const value = item.str ?? "";
      text += value;
      text += item.hasEOL ? "\n" : " ";
    }
    pages.push(text.replace(/[ \t]+\n/gu, "\n").trim());
  }
  return { pages };
}

export function formatPdfVerificationPages(
  pages: string[],
  firstPage = 1,
): VerificationExtraction {
  if (!Number.isSafeInteger(firstPage) || firstPage < 1) {
    throw new Error("first_page must be a positive integer");
  }
  if (pages.some((page) => /<<pg\.\s*\d+>>/iu.test(page))) {
    throw new Error("PDF text already contains Authority Trace page markers");
  }
  const emptyPages = pages.filter((page) => page.trim().length === 0).length;
  const warnings: ExtractionWarning[] =
    pages.length > 0 && emptyPages / pages.length >= OCR_EMPTY_PAGE_RATIO
      ? ["ocr_required"]
      : [];
  const markdown = pages
    .map(
      (page, index) =>
        `<<pg. ${firstPage + index}>>${page.trim() ? `\n${page.trim()}` : ""}`,
    )
    .join("\n\n");
  return {
    markdown: `${markdown.trim()}\n`,
    mediaType: "application/pdf",
    pageCount: pages.length,
    warnings,
  };
}

export async function extractPdfForVerification(
  bytes: Uint8Array,
  firstPage = 1,
  loader: PdfPageLoader = loadPdfPages,
): Promise<VerificationExtraction> {
  const { pages } = await loader(bytes);
  return formatPdfVerificationPages(pages, firstPage);
}
