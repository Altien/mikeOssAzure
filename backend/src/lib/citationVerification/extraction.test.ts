import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  OCR_EMPTY_PAGE_RATIO,
  extractDocxForVerification,
  extractPdfForVerification,
  formatPdfVerificationPages,
} from "./extraction";

const ns =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const paragraph = (text: string, extra = "") =>
  `<w:p>${extra}<w:r><w:t>${text}</w:t></w:r></w:p>`;

async function docxFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${ns}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Decision</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body </w:t></w:r><w:ins w:id="1"><w:r><w:t>accepted</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>deleted</w:delText></w:r></w:del><w:r><w:footnoteReference w:id="1"/><w:endnoteReference w:id="2"/></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc>${paragraph("Rule")}</w:tc><w:tc>${paragraph("Result")}</w:tc></w:tr>
        <w:tr><w:tc>${paragraph("A")}</w:tc><w:tc>${paragraph("B")}</w:tc></w:tr>
      </w:tbl>
    </w:body></w:document>`,
  );
  zip.file(
    "word/footnotes.xml",
    `<?xml version="1.0"?><w:footnotes ${ns}><w:footnote w:id="1">${paragraph("Footnote authority")}</w:footnote></w:footnotes>`,
  );
  zip.file(
    "word/endnotes.xml",
    `<?xml version="1.0"?><w:endnotes ${ns}><w:endnote w:id="2">${paragraph("Endnote authority")}</w:endnote></w:endnotes>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("extractDocxForVerification", () => {
  it("preserves headings, tables, footnotes, endnotes, and accept-all revisions", async () => {
    const result = await extractDocxForVerification(await docxFixture());

    expect(result.markdown).toContain("# Decision");
    expect(result.markdown).toContain("Body accepted[^fn-1][^en-2]");
    expect(result.markdown).not.toContain("deleted");
    expect(result.markdown).toContain("| Rule | Result |");
    expect(result.markdown).toContain("[^fn-1]: Footnote authority");
    expect(result.markdown).toContain("[^en-2]: Endnote authority");
    expect(result.warnings).toEqual(["revisions_present"]);
  });

  it("emits byte-identical Markdown for identical input", async () => {
    const fixture = await docxFixture();
    const first = await extractDocxForVerification(fixture);
    const second = await extractDocxForVerification(fixture);

    expect(new TextEncoder().encode(first.markdown)).toEqual(
      new TextEncoder().encode(second.markdown),
    );
  });
});

describe("PDF verification extraction", () => {
  it("marks every page and honors a printed first-page offset", () => {
    const result = formatPdfVerificationPages(
      ["First page", "Second page"],
      17,
    );

    expect(result.markdown).toBe(
      "<<pg. 17>>\nFirst page\n\n<<pg. 18>>\nSecond page\n",
    );
    expect(result.pageCount).toBe(2);
  });

  it("returns ocr_required without fabricating content at the empty-page threshold", () => {
    const pageCount = 10;
    const emptyCount = pageCount * OCR_EMPTY_PAGE_RATIO;
    const result = formatPdfVerificationPages([
      ...Array.from({ length: emptyCount }, () => ""),
      ...Array.from({ length: pageCount - emptyCount }, () => "text"),
    ]);

    expect(result.warnings).toEqual(["ocr_required"]);
    expect(result.markdown).not.toMatch(/ocr text|fabricated/iu);
  });

  it("refuses double marking and invalid page offsets", () => {
    expect(() => formatPdfVerificationPages(["<<pg. 1>>\ntext"])).toThrow(
      /already contains/i,
    );
    expect(() => formatPdfVerificationPages(["text"], 0)).toThrow(
      /positive integer/i,
    );
  });

  it("uses the injected page loader deterministically", async () => {
    const loader = async () => ({ pages: ["One", "Two"] });
    const first = await extractPdfForVerification(
      new Uint8Array([1]),
      4,
      loader,
    );
    const second = await extractPdfForVerification(
      new Uint8Array([1]),
      4,
      loader,
    );

    expect(first).toEqual(second);
  });
});
