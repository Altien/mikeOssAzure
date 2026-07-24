import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { spreadsheetToLLMText } from "./spreadsheet";

function workbookBuffer(sheet: XLSX.WorkSheet): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

async function replaceWorksheetDimension(
  buffer: Buffer,
  dimension: string,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const sheetPath = "xl/worksheets/sheet1.xml";
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error(`${sheetPath} missing from test workbook`);
  const xml = await sheetFile.async("string");
  zip.file(
    sheetPath,
    xml.replace(
      /<dimension ref="[^"]+"\s*\/>/,
      `<dimension ref="${dimension}"/>`,
    ),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("spreadsheetToLLMText", () => {
  it("ignores a forged full-grid !ref when only one cell is populated", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["safe"]]);
    const buffer = await replaceWorksheetDimension(
      workbookBuffer(sheet),
      "A1:XFD1048576",
    );

    expect(spreadsheetToLLMText(buffer)).toContain("| 1 | safe |");
  });

  it("rejects a sparse content range that would require excessive iteration", () => {
    const sheet: XLSX.WorkSheet = {
      A1: { t: "s", v: "start" },
      A5001: { t: "s", v: "end" },
      "!ref": "A1:A5001",
    };

    expect(() => spreadsheetToLLMText(workbookBuffer(sheet))).toThrow(
      /too large to read safely/,
    );
  });

  it("preserves normal cell-addressed markdown output", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Name", "Amount"],
      ["Matter A", 1200],
    ]);
    sheet.B2.z = "$#,##0";

    const text = spreadsheetToLLMText(workbookBuffer(sheet));

    expect(text).toContain("## Sheet: Sheet1");
    expect(text).toContain("| Row | A | B |");
    expect(text).toContain("| 2 | Matter A | $1,200 |");
  });
});
