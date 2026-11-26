export type DocumentViewType = "pdf" | "docx" | "spreadsheet";

type LegacyDocViewType = Extract<DocumentViewType, "pdf" | "docx">;

export interface ResolveDocumentViewTypeOptions {
  filename?: string | null;
  fileType?: string | null;
  /** Legacy .doc files require a PDF rendition because DocxView cannot parse them. */
  legacyDocViewType?: LegacyDocViewType;
  /** Some stored Word documents have a generated PDF preview. */
  preferPdfForWord?: boolean;
}

type DocumentTypeToken =
  "pdf" | "doc" | "docx" | "spreadsheet" | "presentation" | "other";

function documentTypeToken(
  value: string | null | undefined,
): DocumentTypeToken {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "other";

  if (normalized.includes("spreadsheet") || normalized.includes("ms-excel")) {
    return "spreadsheet";
  }
  if (normalized.includes("wordprocessing") || normalized.includes("msword")) {
    return normalized.includes("openxml") ? "docx" : "doc";
  }
  if (normalized.includes("presentation")) return "presentation";
  if (normalized === "application/pdf") return "pdf";

  const withoutQuery = normalized.split(/[?#]/, 1)[0];
  const token = withoutQuery.includes(".")
    ? (withoutQuery.split(".").pop() ?? "")
    : withoutQuery;

  if (token === "xlsx" || token === "xlsm" || token === "xls") {
    return "spreadsheet";
  }
  if (token === "docx" || token === "word") return "docx";
  if (token === "doc") return "doc";
  if (token === "pptx" || token === "ppt") return "presentation";
  if (token === "pdf") return "pdf";
  return "other";
}

/**
 * Resolve the shared viewer used for a document-like asset. Unsupported and
 * presentation formats fall back to PdfView because the backend supplies a
 * PDF rendition for those formats where required.
 */
export function resolveDocumentViewType({
  filename,
  fileType,
  legacyDocViewType = "pdf",
  preferPdfForWord = false,
}: ResolveDocumentViewTypeOptions): DocumentViewType {
  const fileTypeToken = documentTypeToken(fileType);
  const filenameToken = documentTypeToken(filename);

  if (fileTypeToken === "spreadsheet" || filenameToken === "spreadsheet") {
    return "spreadsheet";
  }

  const wordToken =
    fileTypeToken === "doc" || fileTypeToken === "docx"
      ? fileTypeToken
      : filenameToken === "doc" || filenameToken === "docx"
        ? filenameToken
        : null;
  if (wordToken) {
    if (preferPdfForWord) return "pdf";
    return wordToken === "doc" ? legacyDocViewType : "docx";
  }

  return "pdf";
}

/** Text formats stored verbatim (an imported email's Markdown, a written note). */
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "csv", "html", "xml", "yaml", "yml"]);

/**
 * Whether a document is stored text, shown as text rather than through a PDF
 * rendition it does not have. Decided by the filename, since a source
 * document's panel type has no text kind.
 */
export function isTextDocumentFilename(filename: string | null | undefined): boolean {
  const name = (filename ?? "").trim().toLowerCase();
  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return TEXT_EXTENSIONS.has(extension);
}
