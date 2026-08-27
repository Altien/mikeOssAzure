import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDocx } from "../chat/tools/documentOps";
import { verifyDownload } from "../downloadTokens";
import { createServerSQLite } from "../sqlite";
import { downloadFile, listFiles } from "../storage";

async function generatedDocumentXml(storagePath: string): Promise<string> {
  const bytes = await downloadFile(storagePath);
  if (!bytes) throw new Error(`Missing generated file at ${storagePath}`);
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(bytes);
  const documentXml = archive.file("word/document.xml");
  if (!documentXml) throw new Error("Generated DOCX has no word/document.xml");
  return documentXml.async("string");
}

async function generatedNumberingXml(storagePath: string): Promise<string> {
  const bytes = await downloadFile(storagePath);
  if (!bytes) throw new Error(`Missing generated file at ${storagePath}`);
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(bytes);
  const numberingXml = archive.file("word/numbering.xml");
  if (!numberingXml) throw new Error("Generated DOCX has no word/numbering.xml");
  return numberingXml.async("string");
}

function paragraphContaining(xml: string, text: string): string {
  return (
    xml
      .match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
      ?.find((paragraph) => paragraph.includes(text)) ?? ""
  );
}

const original = {
  signingSecret: process.env.DOWNLOAD_SIGNING_SECRET,
  dbPath: process.env.SQLITE_DB_PATH,
  storagePath: process.env.SQLITE_STORAGE_PATH,
};

beforeAll(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.SQLITE_STORAGE_PATH = ":memory:";
});

afterAll(() => {
  if (original.signingSecret === undefined)
    delete process.env.DOWNLOAD_SIGNING_SECRET;
  else process.env.DOWNLOAD_SIGNING_SECRET = original.signingSecret;
  if (original.dbPath === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = original.dbPath;
  if (original.storagePath === undefined)
    delete process.env.SQLITE_STORAGE_PATH;
  else process.env.SQLITE_STORAGE_PATH = original.storagePath;
});

describe("generateDocx", () => {
  it("fails before storing bytes when download signing is not configured", async () => {
    delete process.env.DOWNLOAD_SIGNING_SECRET;
    const result = await generateDocx(
      "Configuration test",
      [{ heading: "Summary", content: "Test content." }],
      "test-user",
      createServerSQLite(),
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("DOWNLOAD_SIGNING_SECRET"),
      }),
    );
    await expect(listFiles("generated/test-user/")).resolves.toEqual([]);
  });

  it("creates a signed, stored, and indexed Word document", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "document-generation-test-secret";
    const db = createServerSQLite();
    const result = await generateDocx(
      "Generated agreement",
      [{ heading: "Terms", content: "These are the agreed terms." }],
      "test-user",
      db,
    );

    expect(result).not.toHaveProperty("error");
    const generated = result as {
      download_url: string;
      document_id: string;
      version_id: string;
      storage_path: string;
    };
    const token = generated.download_url.replace(/^\/download\//, "");
    expect(verifyDownload(token)).toMatchObject({
      path: generated.storage_path,
    });
    const bytes = await downloadFile(generated.storage_path);
    expect(Buffer.from(bytes as ArrayBuffer).subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );

    const { data: document } = await db
      .from("documents")
      .select("*")
      .eq("id", generated.document_id)
      .single();
    const { data: version } = await db
      .from("document_versions")
      .select("*")
      .eq("id", generated.version_id)
      .single();
    expect(document).toMatchObject({
      user_id: "test-user",
      current_version_id: generated.version_id,
    });
    expect(version).toMatchObject({
      document_id: generated.document_id,
      storage_path: generated.storage_path,
      file_type: "docx",
    });
  });

  it("does not number demand-letter headings or prose by default", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "document-generation-test-secret";
    const result = await generateDocx(
      "Demand Letter",
      [
        {
          heading: "Demand for Payment",
          content:
            "We represent the claimant.\nPayment is required within ten days.",
        },
      ],
      "demand-letter-user",
      createServerSQLite(),
    );

    expect(result).not.toHaveProperty("error");
    const xml = await generatedDocumentXml(
      (result as { storage_path: string }).storage_path,
    );
    expect(paragraphContaining(xml, "Demand for Payment")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(xml, "We represent the claimant."),
    ).not.toContain("<w:numPr>");
    expect(
      paragraphContaining(xml, "Payment is required within ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("numbers only headings when legal section numbering is requested", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "document-generation-test-secret";
    const result = await generateDocx(
      "Numbered Agreement",
      [
        {
          heading: "Payment Terms",
          content: "Payment is due monthly.\nInvoices are payable in ten days.",
        },
      ],
      "numbered-agreement-user",
      createServerSQLite(),
      { numberSections: true },
    );

    expect(result).not.toHaveProperty("error");
    const xml = await generatedDocumentXml(
      (result as { storage_path: string }).storage_path,
    );
    expect(paragraphContaining(xml, "PAYMENT TERMS")).toContain("<w:numPr>");
    expect(paragraphContaining(xml, "Payment is due monthly.")).not.toContain(
      "<w:numPr>",
    );
    expect(
      paragraphContaining(xml, "Invoices are payable in ten days."),
    ).not.toContain("<w:numPr>");
  });

  it("preserves typed numbering in an unnumbered document", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "document-generation-test-secret";
    const result = await generateDocx(
      "Notice",
      [{ content: "1. This reference is intentional." }],
      "unnumbered-notice-user",
      createServerSQLite(),
    );

    expect(result).not.toHaveProperty("error");
    const xml = await generatedDocumentXml(
      (result as { storage_path: string }).storage_path,
    );
    expect(xml).toContain("1. This reference is intentional.");
    expect(
      paragraphContaining(xml, "1. This reference is intentional."),
    ).not.toContain("<w:numPr>");
  });

  it("renders explicit bullets as bullets rather than legal clauses", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "document-generation-test-secret";
    const result = await generateDocx(
      "Requirements Memo",
      [
        {
          heading: "Requirements",
          content: "- First item\n- Second item",
        },
      ],
      "bulleted-requirements-user",
      createServerSQLite(),
      { numberSections: true },
    );

    expect(result).not.toHaveProperty("error");
    const storagePath = (result as { storage_path: string }).storage_path;
    const xml = await generatedDocumentXml(storagePath);
    const numberingXml = await generatedNumberingXml(storagePath);

    const first = paragraphContaining(xml, "First item");
    const second = paragraphContaining(xml, "Second item");
    expect(first).toContain("<w:numPr>");
    expect(second).toContain("<w:numPr>");
    expect(first).not.toContain("- First item");
    expect(second).not.toContain("- Second item");
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"/>');
  });
});
