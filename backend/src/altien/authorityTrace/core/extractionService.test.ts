import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../../test/helpers/fakeDb";

const { downloadFileMock, uploadFileMock, extractDocxMock, extractPdfMock } =
  vi.hoisted(() => ({
    downloadFileMock: vi.fn(),
    uploadFileMock: vi.fn(),
    extractDocxMock: vi.fn(),
    extractPdfMock: vi.fn(),
  }));

vi.mock("../../../lib/storage", () => ({
  downloadFile: downloadFileMock,
  uploadFile: uploadFileMock,
  versionStorageKey: (
    userId: string,
    documentId: string,
    versionId: string,
    filename: string,
  ) => `documents/${userId}/${documentId}/versions/${versionId}/${filename}`,
}));
vi.mock("./extraction", () => ({
  extractDocxForVerification: extractDocxMock,
  extractPdfForVerification: extractPdfMock,
}));

import { extractDocumentForVerification } from "./extractionService";

function database(options?: {
  projectId?: string;
  fileType?: string;
  writeErrorTable?: string;
}) {
  const respond = (call: DbCall) => {
    if (call.table === "documents" && call.op === "select") {
      return {
        data: [{
          id: "source-doc",
          project_id: options?.projectId ?? "project-1",
          current_version_id: "source-v1",
          status: "ready",
        }],
      };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return {
        data: [{
          id: "source-v1",
          document_id: "source-doc",
          storage_path: "source/path",
          filename: "Opinion.docx",
          file_type: options?.fileType ?? "docx",
        }],
      };
    }
    if (
      call.table === options?.writeErrorTable &&
      call.op !== "select"
    ) {
      return { error: { message: "write failed" } };
    }
    return { data: [] };
  };
  return makeFakeDb(respond);
}

beforeEach(() => {
  downloadFileMock.mockReset().mockResolvedValue(
    new TextEncoder().encode("source bytes").buffer,
  );
  uploadFileMock.mockReset().mockResolvedValue(undefined);
  extractDocxMock.mockReset().mockResolvedValue({
    markdown: "# Extracted\n",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pageCount: null,
    warnings: ["revisions_present"],
  });
  extractPdfMock.mockReset().mockResolvedValue({
    markdown: "<<pg. 4>>\nExtracted\n",
    mediaType: "application/pdf",
    pageCount: 1,
    warnings: [],
  });
});

describe("extractDocumentForVerification", () => {
  it("writes immutable Markdown then records source provenance", async () => {
    const { db, calls } = database();
    const result = await extractDocumentForVerification(
      {
        projectId: "project-1",
        userId: "user-1",
        documentId: "doc-0",
        docIndex: {
          "doc-0": { document_id: "source-doc", filename: "Opinion.docx" },
        },
      },
      db as never,
    );

    expect(uploadFileMock).toHaveBeenCalledOnce();
    expect(uploadFileMock.mock.calls[0][2]).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(result).toMatchObject({
      source_document_id: "source-doc",
      source_version_id: "source-v1",
      filename: "Opinion.verification.md",
      media_type: "text/markdown",
      warnings: ["revisions_present"],
    });
    expect(calls.map((call) => `${call.table}:${call.op}`)).toEqual([
      "documents:select",
      "document_versions:select",
      "documents:insert",
      // Dev drift: upstream #295 routes version writes through the documents
      // lifecycle facade (create_document_version RPC).
      "create_document_version:rpc",
      "documents:update",
      "citation_verification_extractions:insert",
    ]);
    expect(
      calls.find(
        (call) => call.table === "citation_verification_extractions",
      )?.payload,
    ).toMatchObject({
      source_document_id: "source-doc",
      source_version_id: "source-v1",
      extracted_document_id: result.extracted_document_id,
      extracted_version_id: result.extracted_version_id,
    });
    expect(calls.find((call) => call.op === "update")?.filters).toContainEqual(
      ["eq", "id", result.extracted_document_id],
    );
  });

  it("passes a PDF printed-page offset and records it", async () => {
    const { db, callsFor } = database({ fileType: "pdf" });
    await extractDocumentForVerification(
      {
        projectId: "project-1",
        userId: "user-1",
        documentId: "source-doc",
        firstPage: 4,
        docIndex: {
          "doc-0": { document_id: "source-doc", filename: "Opinion.pdf" },
        },
      },
      db as never,
    );

    expect(extractPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), 4);
    expect(
      callsFor("citation_verification_extractions", "insert")[0].payload,
    ).toMatchObject({ options: { first_page: 4 } });
  });

  it("rejects cross-project extraction before reading storage", async () => {
    const { db, calls } = database({ projectId: "project-2" });
    await expect(
      extractDocumentForVerification(
        {
          projectId: "project-1",
          userId: "user-1",
          documentId: "doc-0",
          docIndex: {
            "doc-0": { document_id: "source-doc", filename: "Opinion.docx" },
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/not accessible/i);

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("fails visibly before metadata writes when storage upload is unavailable", async () => {
    const { db, calls } = database();
    uploadFileMock.mockRejectedValue(
      new Error("Storage is not configured (cannot upload)"),
    );

    await expect(
      extractDocumentForVerification(
        {
          projectId: "project-1",
          userId: "user-1",
          documentId: "doc-0",
          docIndex: {
            "doc-0": { document_id: "source-doc", filename: "Opinion.docx" },
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/storage is not configured/i);

    expect(calls.map((call) => call.op)).toEqual(["select", "select"]);
  });

  it("rejects unsupported inputs without writing storage", async () => {
    const { db } = database({ fileType: "xlsx" });
    await expect(
      extractDocumentForVerification(
        {
          projectId: "project-1",
          userId: "user-1",
          documentId: "doc-0",
          docIndex: {
            "doc-0": { document_id: "source-doc", filename: "Opinion.xlsx" },
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/only DOCX and text-layer PDF/i);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});
