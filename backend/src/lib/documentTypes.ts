export const ALLOWED_DOCUMENT_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
]);

export const ALLOWED_DOCUMENT_TYPES_LABEL =
  "pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt";

/**
 * Text formats Mike stores verbatim: the bytes are the content, so they are
 * written and read back without a converter. Separate from
 * ALLOWED_DOCUMENT_TYPES, which is what a person may upload.
 */
const TEXT_TYPES = new Map<string, string>([
  ["md", "text/markdown; charset=utf-8"],
  ["markdown", "text/markdown; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["csv", "text/csv; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["xml", "application/xml; charset=utf-8"],
  ["yaml", "application/yaml; charset=utf-8"],
  ["yml", "application/yaml; charset=utf-8"],
]);

export const TEXT_DOCUMENT_TYPES_LABEL =
  "md, markdown, txt, json, csv, html, xml, yaml, yml";

export function isTextDocumentType(fileType: string | null | undefined) {
  return TEXT_TYPES.has((fileType ?? "").toLowerCase());
}

export function contentTypeForTextDocumentType(
  fileType: string | null | undefined,
) {
  return (
    TEXT_TYPES.get((fileType ?? "").toLowerCase()) ?? "text/plain; charset=utf-8"
  );
}

const WORD_TYPES = new Set(["docx", "doc"]);
const SPREADSHEET_TYPES = new Set(["xlsx", "xlsm", "xls"]);
const PRESENTATION_TYPES = new Set(["pptx", "ppt"]);

export function isWordDocumentType(fileType: string | null | undefined) {
  return WORD_TYPES.has((fileType ?? "").toLowerCase());
}

export function isSpreadsheetDocumentType(fileType: string | null | undefined) {
  return SPREADSHEET_TYPES.has((fileType ?? "").toLowerCase());
}

export function isPresentationDocumentType(fileType: string | null | undefined) {
  return PRESENTATION_TYPES.has((fileType ?? "").toLowerCase());
}

export function shouldConvertToPdf(fileType: string | null | undefined) {
  const normalized = (fileType ?? "").toLowerCase();
  // Spreadsheets are intentionally excluded: they are rendered natively as a
  // grid in the frontend (Fortune-sheet) from the raw file bytes rather than a
  // PDF rendition, which clipped wide/large sheets.
  return (
    isWordDocumentType(normalized) || isPresentationDocumentType(normalized)
  );
}

/**
 * The types whose text can only be read by round-tripping the file through
 * LibreOffice. Every other allowed type has an in-process reader — docx via
 * the tracked-changes extractor (mammoth as fallback), pptx via officeText,
 * spreadsheets via SheetJS, pdf via pdfjs — so .doc and .ppt are the only
 * ones read_document pays a subprocess conversion for, and therefore the only
 * ones worth precomputing and caching.
 */
export function requiresLibreOfficeTextExtraction(
  fileType: string | null | undefined,
) {
  const normalized = (fileType ?? "").toLowerCase();
  return normalized === "doc" || normalized === "ppt";
}

export function contentTypeForDocumentType(fileType: string | null | undefined) {
  switch ((fileType ?? "").toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case "xls":
      return "application/vnd.ms-excel";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    default:
      return "application/octet-stream";
  }
}
