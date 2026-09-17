import { describe, expect, it, vi } from "vitest";

const bytes = new TextEncoder().encode("# notes\n\nfirst write\n");

vi.mock("../../storage", () => ({
  downloadFile: vi.fn(async () =>
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  ),
  uploadFile: vi.fn(),
  versionStorageKey: vi.fn(),
  deleteFile: vi.fn(),
}));

import { readDocumentContent } from "./documentOps";

describe("read_document on a text document", () => {
  /**
   * Text file types used to fall past every branch into the DOCX path and come
   * back as "Document could not be read", so anything write_project_document
   * wrote was write-only — which defeats the point of writing it.
   */
  it("returns the bytes as the content", async () => {
    const filename = "notes.md";
    const store = new Map([
      [filename, { storage_path: "documents/x/notes.md", file_type: "md", filename }],
    ]);
    const text = await readDocumentContent(
      filename,
      store as never,
      () => {},
      undefined,
      undefined,
      { emitEvents: false },
    );
    expect(text).toContain("first write");
  });
});
