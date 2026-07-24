import * as XLSX from "xlsx";

/**
 * Spreadsheet parsing for the LLM read path.
 *
 * Replaces the old regex-over-OOXML extractor (`extractSpreadsheetText`) with a
 * real reader. SheetJS handles `.xlsx`, `.xlsm`, and legacy `.xls` uniformly and
 * exposes `cell.w` — the Excel-formatted display string — so dates and currency
 * reach the model the way a human sees them (`3/1/26`, `$1,200`) rather than as
 * raw serial numbers. Cached formula results are used (we never show formulas).
 *
 * The output is a compact, cell-addressed markdown table per sheet: a header row
 * of column letters plus a leftmost row-number column. That lets the model name
 * any cell as `Sheet!<col><row>` (e.g. `Q3 Budget!B7`) for cell-level citations,
 * with none of the old `Row N:` / `|`-separator noise.
 */

/** Formatted display text for a cell (`w`), falling back to the raw value. */
function cellDisplayText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (typeof cell.w === "string" && cell.w.length > 0) return cell.w;
  if (cell.v == null) return "";
  return String(cell.v);
}

/** Escape a cell value so it can't break the markdown table layout. */
function sanitizeCellText(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

const MAX_RENDERED_ROWS = 5_000;
const MAX_RENDERED_COLUMNS = 256;
const MAX_RENDERED_CELLS = 100_000;

function findContentRange(
  ws: XLSX.WorkSheet,
  mergeAnchors: Map<string, string>,
): XLSX.Range | null {
  let minRow = Number.POSITIVE_INFINITY;
  let minCol = Number.POSITIVE_INFINITY;
  let maxRow = -1;
  let maxCol = -1;
  let contentCells = 0;

  const addresses = new Set([
    ...Object.keys(ws).filter((key) => !key.startsWith("!")),
    ...mergeAnchors.keys(),
  ]);
  for (const address of addresses) {
    if (!/^[A-Z]+[1-9][0-9]*$/i.test(address)) continue;
    const hasContent =
      mergeAnchors.has(address) ||
      sanitizeCellText(cellDisplayText(ws[address])).length > 0;
    if (!hasContent) continue;

    contentCells++;
    if (contentCells > MAX_RENDERED_CELLS) {
      throw new Error(
        `Spreadsheet sheet contains more than ${MAX_RENDERED_CELLS.toLocaleString()} populated cells and is too large to read safely.`,
      );
    }

    const { r, c } = XLSX.utils.decode_cell(address);
    minRow = Math.min(minRow, r);
    minCol = Math.min(minCol, c);
    maxRow = Math.max(maxRow, r);
    maxCol = Math.max(maxCol, c);
  }

  if (maxRow < 0 || maxCol < 0) return null;

  const rowCount = maxRow - minRow + 1;
  const columnCount = maxCol - minCol + 1;
  const gridCells = rowCount * columnCount;
  if (
    rowCount > MAX_RENDERED_ROWS ||
    columnCount > MAX_RENDERED_COLUMNS ||
    gridCells > MAX_RENDERED_CELLS
  ) {
    throw new Error(
      `Spreadsheet used range (${rowCount.toLocaleString()} rows × ${columnCount.toLocaleString()} columns) is too large to read safely.`,
    );
  }

  return {
    s: { r: minRow, c: minCol },
    e: { r: maxRow, c: maxCol },
  };
}

function renderSheet(sheetName: string, ws: XLSX.WorkSheet): string | null {
  const ref = ws["!ref"];
  if (!ref) return null;

  // Map each merged range's top-left (anchor) address to its encoded range so we
  // can tag the anchor inline (e.g. `Amount ⟨merged B2:C2⟩`). The covered cells
  // stay blank, so the model never reads a covered address (e.g. B1 inside
  // A1:C1) as its own value; the tag tells it the anchor spans that range, and
  // to cite the whole range for anything in it.
  const mergeAnchors = new Map<string, string>();
  for (const m of ws["!merges"] ?? []) {
    mergeAnchors.set(XLSX.utils.encode_cell(m.s), XLSX.utils.encode_range(m));
  }

  // Never trust `!ref` for iteration bounds. A tiny hostile workbook can claim
  // Excel's full A1:XFD1048576 grid and turn a single-cell document into
  // billions of loop iterations. Derive bounds from populated cells/merge
  // anchors, then enforce a useful upper bound for the LLM read path.
  const range = findContentRange(ws, mergeAnchors);
  if (!range) return null;

  // Build a trimmed grid: capture formatted text for every cell in the used
  // range, then drop trailing empty columns and fully empty rows so we don't
  // emit oceans of blank cells.
  const rows: { rowNumber: number; cells: string[] }[] = [];
  let lastNonEmptyCol = -1;

  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = [];
    let rowHasContent = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      let text = sanitizeCellText(cellDisplayText(ws[addr]));
      const mergeRange = mergeAnchors.get(addr);
      if (mergeRange) {
        text = text
          ? `${text} ⟨merged ${mergeRange}⟩`
          : `⟨merged ${mergeRange}⟩`;
      }
      cells[c - range.s.c] = text;
      if (text) {
        rowHasContent = true;
        if (c - range.s.c > lastNonEmptyCol) lastNonEmptyCol = c - range.s.c;
      }
    }
    if (rowHasContent) rows.push({ rowNumber: r + 1, cells });
  }

  if (rows.length === 0 || lastNonEmptyCol < 0) return null;

  // Column-letter header, e.g. ["A", "B", "C"] for the used columns.
  const colLetters: string[] = [];
  for (let c = 0; c <= lastNonEmptyCol; c++) {
    colLetters.push(XLSX.utils.encode_col(range.s.c + c));
  }

  const headerRow = `| Row | ${colLetters.join(" | ")} |`;
  const separator = `| --- | ${colLetters.map(() => "---").join(" | ")} |`;
  const bodyRows = rows.map(({ rowNumber, cells }) => {
    const padded: string[] = [];
    for (let c = 0; c <= lastNonEmptyCol; c++) padded.push(cells[c] ?? "");
    return `| ${rowNumber} | ${padded.join(" | ")} |`;
  });

  const lines = [
    `## Sheet: ${sheetName}`,
    "",
    headerRow,
    separator,
    ...bodyRows,
  ];

  return lines.join("\n");
}

/**
 * Extract a spreadsheet as cell-addressed markdown for the LLM. Handles
 * `.xlsx`, `.xlsm`, and legacy `.xls` (SheetJS reads all three), so callers no
 * longer need the LibreOffice→PDF→text detour for spreadsheets.
 */
export function spreadsheetToLLMText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rendered = renderSheet(sheetName, ws);
    if (rendered) sheets.push(rendered);
  }
  return sheets.join("\n\n").trim();
}
