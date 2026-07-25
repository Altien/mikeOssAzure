import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));
vi.mock("../storage", () => ({
  downloadFile: downloadFileMock,
}));

import {
  extractDocxForVerification,
  extractPdfForVerification,
} from "./extraction";
import { verifyCitationSources } from "./service";
import {
  createCitationVerificationReview,
  getAuthorityTraceWorkspace,
} from "./reviewService";
import { buildAuditHtml, buildReviewHtml } from "./exports";

const encoder = new TextEncoder();
const ns =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function generatedDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${ns}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Synthetic memo</w:t></w:r></w:p>
      <w:p><w:r><w:t>Exact v Case confirms the first rule.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
      <w:p><w:r><w:t>Normal v Case confirms the second rule.</w:t></w:r><w:r><w:endnoteReference w:id="2"/></w:r></w:p>
      <w:p><w:r><w:t>Missing v Case is also asserted.</w:t></w:r></w:p>
    </w:body></w:document>`,
  );
  zip.file(
    "word/footnotes.xml",
    `<?xml version="1.0"?><w:footnotes ${ns}><w:footnote w:id="1"><w:p><w:r><w:t>Generated footnote citation.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
  );
  zip.file(
    "word/endnotes.xml",
    `<?xml version="1.0"?><w:endnotes ${ns}><w:endnote w:id="2"><w:p><w:r><w:t>Generated endnote citation.</w:t></w:r></w:p></w:endnote></w:endnotes>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

function generatedPdf(): Uint8Array {
  const firstPage =
    "BT /F1 12 Tf 72 720 Td (The court adopted the long-term second rule.) Tj ET";
  const secondPage =
    "BT /F1 12 Tf 72 720 Td (Generated second page.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${firstPage.length} >>\nstream\n${firstPage}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${secondPage.length} >>\nstream\n${secondPage}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function filterValue(call: DbCall, column: string): unknown {
  return call.filters.find(
    ([operation, name]) => operation === "eq" && name === column,
  )?.[2];
}

describe("Authority Trace synthetic reviewer journey", () => {
  beforeEach(() => downloadFileMock.mockReset());

  it("extracts, verifies, persists, reviews, reruns, marks stale, and exports", async () => {
    const docx = await extractDocxForVerification(await generatedDocx());
    const pdf = await extractPdfForVerification(
      generatedPdf(),
      17,
    );
    const generatedText = "The court adopted the exact first rule.";

    expect(docx.markdown).toContain("Generated footnote citation.");
    expect(docx.markdown).toContain("Generated endnote citation.");
    expect(pdf.markdown).toContain("<<pg. 17>>");
    expect(pdf.markdown).toContain("<<pg. 18>>");

    const documents = [
      {
        id: "memo-id",
        project_id: "project-1",
        current_version_id: "memo-v1",
        status: "ready",
      },
      {
        id: "text-id",
        project_id: "project-1",
        current_version_id: "text-v1",
        status: "ready",
      },
      {
        id: "pdf-id",
        project_id: "project-1",
        current_version_id: "pdf-v1",
        status: "ready",
      },
    ];
    const versions = [
      {
        id: "memo-v1",
        document_id: "memo-id",
        storage_path: "memo/path",
        filename: "memo.verification.md",
        file_type: "md",
      },
      {
        id: "text-v1",
        document_id: "text-id",
        storage_path: "text/path",
        filename: "authority.txt",
        file_type: "txt",
      },
      {
        id: "pdf-v1",
        document_id: "pdf-id",
        storage_path: "pdf/path",
        filename: "opinion.verification.md",
        file_type: "md",
      },
    ];
    const content = new Map([
      ["memo/path", encoder.encode(docx.markdown).buffer],
      ["text/path", encoder.encode(generatedText).buffer],
      ["pdf/path", encoder.encode(pdf.markdown).buffer],
    ]);
    downloadFileMock.mockImplementation(async (path: string) =>
      content.get(path),
    );

    const runs: Array<Record<string, unknown>> = [];
    const reviews: Array<Record<string, unknown>> = [];
    const respond = (call: DbCall) => {
      if (call.table === "documents") return { data: documents };
      if (call.table === "document_versions") return { data: versions };
      if (call.table === "external_source_cache") return { data: [] };
      if (call.table === "citation_verification_runs") {
        if (call.op === "insert") {
          const row = {
            ...(call.payload as object),
            id: `run-${runs.length + 1}`,
            created_at: `2026-07-25T12:0${runs.length}:00.000Z`,
          };
          runs.push(row);
          return { data: [{ id: row.id }] };
        }
        if (call.columns === "id") {
          return { data: runs.map(({ id }) => ({ id })) };
        }
        const runId = filterValue(call, "id");
        const selected = runs.filter((row) => row.id === runId);
        return call.columns === "verified_record"
          ? {
              data: selected.map(({ verified_record }) => ({
                verified_record,
              })),
            }
          : { data: selected };
      }
      if (call.table === "citation_verification_reviews") {
        if (call.op === "insert") {
          const row = {
            ...(call.payload as object),
            id: `review-${reviews.length + 1}`,
            created_at: `2026-07-25T13:0${reviews.length}:00.000Z`,
          };
          reviews.push(row);
          return { data: [row] };
        }
        return { data: reviews };
      }
      return { data: [] };
    };
    const { db } = makeFakeDb(respond);
    const docIndex = {
      "doc-0": {
        document_id: "memo-id",
        filename: "memo.verification.md",
      },
      "doc-1": { document_id: "text-id", filename: "authority.txt" },
      "doc-2": {
        document_id: "pdf-id",
        filename: "opinion.verification.md",
      },
    };
    const proposal = {
      schema_version: 1,
      memo: { document_id: "doc-0" },
      sources: {
        text: {
          document_id: "doc-1",
          title: "Generated text authority",
          kind: "case",
        },
        pdf: {
          document_id: "doc-2",
          title: "Generated PDF authority",
          kind: "case",
        },
      },
      citations: [
        {
          id: "c001",
          source_candidates: ["text"],
          cite_text: "Exact v Case",
          proposition: "The first rule applies.",
          support_type: "quotation",
          anchors_proposed: [
            {
              source: "text",
              quote: "The court adopted the exact first rule.",
            },
          ],
        },
        {
          id: "c002",
          source_candidates: ["pdf"],
          cite_text: "Normal v Case",
          proposition: "The second rule applies.",
          support_type: "quotation",
          anchors_proposed: [
            {
              source: "pdf",
              quote: "The court adopted the longterm second rule.",
            },
          ],
        },
        {
          id: "c003",
          source_candidates: ["text"],
          cite_text: "Missing v Case",
          proposition: "An unsupported rule applies.",
          support_type: "quotation",
          anchors_proposed: [
            { source: "text", quote: "This passage does not exist." },
          ],
        },
      ],
    };

    const first = await verifyCitationSources(
      {
        projectId: "project-1",
        userId: "user-1",
        proposal,
        docIndex,
      },
      db as never,
    );
    expect(first.runId).toBe("run-1");
    expect(first.report).toMatchObject({
      exact: 1,
      formatting_different: 1,
      failed: 1,
    });

    await createCitationVerificationReview(
      {
        runId: first.runId,
        body: {
          citation_id: "c001",
          binds_to: first.record.citations[0].binds_to,
          verdict: "verified",
          note: "Repository-generated fixture reviewed.",
        },
        reviewerUserId: "user-1",
        reviewerEmail: "reviewer@example.test",
      },
      db as never,
    );

    const changedProposal = structuredClone(proposal);
    changedProposal.citations[0].proposition =
      "The first rule applies after a material change.";
    const rerun = await verifyCitationSources(
      {
        projectId: "project-1",
        userId: "user-1",
        proposal: changedProposal,
        docIndex,
      },
      db as never,
    );
    const workspace = await getAuthorityTraceWorkspace(
      rerun.runId,
      db as never,
    );

    expect(rerun.runId).toBe("run-2");
    expect(workspace?.current_reviews.c001).toBeUndefined();
    expect(workspace?.reviews).toEqual([
      expect.objectContaining({
        id: "review-1",
        verdict: "verified",
        stale: true,
      }),
    ]);
    expect(workspace?.integrity.ok).toBe(true);

    const reviewHtml = buildReviewHtml(workspace!);
    const auditHtml = buildAuditHtml(workspace!);
    expect(reviewHtml).toContain("Authority Trace offline review");
    expect(reviewHtml).toContain('"stale":true');
    expect(auditHtml).toContain("Authority Trace audit record");
    expect(auditHtml).toContain("verified");
  }, 20_000);
});
