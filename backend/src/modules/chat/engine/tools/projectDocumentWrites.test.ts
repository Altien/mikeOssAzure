import { beforeEach, describe, expect, it, vi } from "vitest";
// Dev drift: #295 moved this file into modules/chat/engine/tools; paths re-rooted.
import { makeFakeDb, type DbCall } from "../../../../test/helpers/fakeDb";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("../../../../lib/storage", () => ({
  uploadFile: uploadFileMock,
  versionStorageKey: (
    userId: string,
    documentId: string,
    versionId: string,
    filename: string,
  ) => `documents/${userId}/${documentId}/versions/${versionId}/${filename}`,
}));

import { writeProjectDocument } from "./projectDocumentWrites";

/**
 * One existing project document, described by its active version. `undefined`
 * means the project is empty.
 */
function database(existing?: {
  documentId?: string;
  versionId?: string;
  filename: string;
  source: string;
  versionNumber?: number;
}) {
  const respond = (call: DbCall) => {
    if (call.table === "documents" && call.op === "select") {
      return existing
        ? {
            data: [
              {
                id: existing.documentId ?? "doc-existing",
                current_version_id: existing.versionId ?? "version-existing",
              },
            ],
          }
        : { data: [] };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return existing
        ? {
            data: [
              {
                id: existing.versionId ?? "version-existing",
                document_id: existing.documentId ?? "doc-existing",
                filename: existing.filename,
                source: existing.source,
                version_number: existing.versionNumber ?? 1,
              },
            ],
          }
        : { data: [] };
    }
    // Dev drift: since #295 versions go through the create_document_version
    // RPC (documents lifecycle), which assigns the next version number and
    // activates it.
    if (call.table === "create_document_version" && call.op === "rpc") {
      return {
        data: {
          version_number: existing ? (existing.versionNumber ?? 1) + 1 : 1,
        },
      };
    }
    return { data: [] };
  };
  return makeFakeDb(respond);
}

function input(overrides?: {
  filename?: string;
  content?: string;
  projectId?: string | null;
}) {
  return {
    filename: overrides?.filename ?? "cites.json",
    content: overrides?.content ?? '{"cites": []}',
    userId: "user-1",
    projectId:
      overrides && "projectId" in overrides ? overrides.projectId : "project-1",
  };
}

beforeEach(() => {
  uploadFileMock.mockReset().mockResolvedValue(undefined);
});

describe("writeProjectDocument", () => {
  it("creates a new project document and returns a download reference", async () => {
    const { db, calls } = database();

    const result = await writeProjectDocument(input(), db as never);

    expect(result).toMatchObject({
      ok: true,
      created: "new",
      filename: "cites.json",
      bytes: 13,
      version_number: 1,
      download_url: expect.stringMatching(/^\/download\/[\w-]+\.[\w-]+$/),
    });
    expect(calls.map((call) => `${call.table}:${call.op}`)).toEqual(
      expect.arrayContaining([
        "documents:insert",
        "create_document_version:rpc",
      ]),
    );
    const versionInsert = calls.find(
      (call) => call.table === "create_document_version" && call.op === "rpc",
    );
    expect(versionInsert?.payload).toMatchObject({
      p_activate: true,
      p_version: {
        source: "tool_write",
        file_type: "json",
        size_bytes: 13,
      },
    });
    const [storagePath, uploaded, contentType] = uploadFileMock.mock.calls[0];
    expect(String(storagePath)).toContain("/versions/");
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
      '{"cites": []}',
    );
  });

  it("uploads before writing any metadata so a storage failure leaves no row", async () => {
    const { db, calls } = database();
    uploadFileMock.mockRejectedValue(new Error("storage is not configured"));

    await expect(
      writeProjectDocument(input(), db as never),
    ).rejects.toThrow("storage is not configured");

    expect(calls.every((call) => call.op === "select")).toBe(true);
  });

  it("adds a version to the document it wrote before, not a second document", async () => {
    const { db, calls } = database({
      filename: "cites.json",
      source: "tool_write",
      versionNumber: 2,
    });

    const result = await writeProjectDocument(
      input({ content: '{"cites": [1]}' }),
      db as never,
    );

    expect(result).toMatchObject({
      ok: true,
      created: "version",
      document_id: "doc-existing",
      version_number: 3,
    });
    expect(
      calls.filter((call) => call.table === "documents" && call.op === "insert"),
    ).toEqual([]);
    const versionInsert = calls.find(
      (call) => call.table === "create_document_version" && call.op === "rpc",
    );
    expect(versionInsert?.payload).toMatchObject({
      p_document_id: "doc-existing",
      p_activate: true,
      p_version: { source: "tool_write" },
    });
  });

  it("refuses a filename belonging to a document it did not write", async () => {
    const { db, calls } = database({
      filename: "cites.json",
      source: "user_upload",
    });

    const result = await writeProjectDocument(input(), db as never);

    expect(result).toMatchObject({
      ok: false,
      error: "filename_conflict",
      detail: expect.stringContaining("uploaded to this project"),
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(calls.every((call) => call.op === "select")).toBe(true);
  });

  it("refuses to take over a generated document and names the conflict", async () => {
    const { db } = database({
      filename: "report.html",
      source: "generated",
    });

    const result = await writeProjectDocument(
      input({ filename: "report.html", content: "<p>x</p>" }),
      db as never,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "filename_conflict",
      detail: expect.stringContaining("generate_docx"),
    });
  });

  it("refuses a binary extension and names the generator that produces it", async () => {
    const { db } = database();

    const docx = await writeProjectDocument(
      input({ filename: "memo.docx", content: "text" }),
      db as never,
    );
    const workbook = await writeProjectDocument(
      input({ filename: "table.xlsx", content: "text" }),
      db as never,
    );

    expect(docx).toMatchObject({
      ok: false,
      error: "unsupported_file_type",
      use_instead: "generate_docx",
      detail: expect.stringContaining("md, markdown, txt, json, csv, html"),
    });
    expect(workbook).toMatchObject({
      ok: false,
      use_instead: "generate_excel",
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("refuses an extension that is neither text nor a generator's format", async () => {
    const { db } = database();

    const result = await writeProjectDocument(
      input({ filename: "notes.exe", content: "text" }),
      db as never,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "unsupported_file_type",
      detail: expect.stringContaining("Allowed:"),
    });
    expect(result).not.toHaveProperty("use_instead");
  });

  it("refuses content over the 1 MiB cap, stating the limit and the size", async () => {
    const { db, calls } = database();
    const oversized = "x".repeat(1024 * 1024 + 1);

    const result = await writeProjectDocument(
      input({ content: oversized }),
      db as never,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "content_too_large",
      detail: expect.stringContaining("1048577 bytes"),
    });
    expect(result).toMatchObject({
      detail: expect.stringContaining("1048576 bytes (1 MiB)"),
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("counts the cap in UTF-8 bytes, not characters", async () => {
    const { db } = database();
    // Just under the cap in characters, well over it in UTF-8 bytes.
    const result = await writeProjectDocument(
      input({ content: "€".repeat(1024 * 512) }),
      db as never,
    );

    expect(result).toMatchObject({ ok: false, error: "content_too_large" });
  });

  it("refuses path traversal and directory separators in the filename", async () => {
    const { db, calls } = database();

    for (const filename of [
      "../../etc/passwd",
      "..\\cites.json",
      "notes/cites.json",
      ".env",
    ]) {
      const result = await writeProjectDocument(
        input({ filename, content: "x" }),
        db as never,
      );
      expect(result).toMatchObject({ ok: false, error: "invalid_filename" });
    }
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses a filename carrying control characters", async () => {
    const { db } = database();

    const result = await writeProjectDocument(
      input({ filename: "cites\u0007.json", content: "x" }),
      db as never,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_filename",
      detail: expect.stringContaining("control characters"),
    });
  });

  it("refuses cleanly when the chat has no active project", async () => {
    const { db, calls } = database();

    const result = await writeProjectDocument(
      input({ projectId: null }),
      db as never,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "no_active_project",
      detail: expect.stringContaining("project chat"),
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("leaves a same-named document in another project alone", async () => {
    // The lookup is project-scoped, so an unrelated project's cites.json is
    // never a conflict and never versioned.
    const { db, calls } = database();

    const result = await writeProjectDocument(input(), db as never);

    expect(result).toMatchObject({ ok: true, created: "new" });
    const lookup = calls.find(
      (call) => call.table === "documents" && call.op === "select",
    );
    expect(lookup?.filters).toEqual([["eq", "project_id", "project-1"]]);
  });
});
