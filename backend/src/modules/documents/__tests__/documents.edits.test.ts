import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const storage = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  assertStorageConfigured: vi.fn(),
}));
const dbq = vi.hoisted(() => ({
  enqueueStorageCleanup: vi.fn(),
  requestDocumentCleanupDelivery: vi.fn(),
}));
const docx = vi.hoisted(() => ({ resolveTrackedChange: vi.fn() }));
const access = vi.hoisted(() => ({ ensureDocAccess: vi.fn() }));

vi.mock("../../../lib/storage", () => ({
  ...storage,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../lib/dbq/enqueue", () => dbq);
vi.mock("../../../lib/docxTrackedChanges", () => ({
  ...docx,
  extractTrackedChangeIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);
vi.mock("../../../lib/permissions", () => ({ can: () => true }));
vi.mock("../../../lib/downloadTokens", () => ({
  buildDownloadUrl: () => "https://example.test/download",
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadActiveVersion: vi.fn(async () => ({
    storage_path: "docs/v1.docx",
    filename: "Clause.docx",
    version_number: 2,
    source: "assistant_edit",
  })),
}));

import { resolveEdit } from "../documents.edits";

const PENDING_EDIT = {
  id: "edit-1",
  document_id: "doc-1",
  change_id: "c1",
  del_w_id: "w-del",
  ins_w_id: "w-ins",
  status: "pending",
};
const DOC = {
  id: "doc-1",
  current_version_id: "v1",
  user_id: "user-1",
  project_id: null,
  org_id: null,
  workflow_id: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function arrange() {
  storage.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  storage.uploadFile.mockResolvedValue(undefined);
  storage.deleteFile.mockResolvedValue(undefined);
  dbq.requestDocumentCleanupDelivery.mockResolvedValue(0);
  docx.resolveTrackedChange.mockResolvedValue({
    bytes: new Uint8Array([9, 9, 9]),
    found: true,
  });
  access.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "owner" });
}

const run = (db: Parameters<typeof resolveEdit>[5]) =>
  resolveEdit("accept", "doc-1", "edit-1", "user-1", "u@example.test", db);

describe("resolving a tracked edit", () => {
  // Measured before the lifecycle work: two direct document_versions updates
  // plus an explicit storage.cleanup enqueue — three db_jobs rows carrying the
  // same key for one click. Now: one pre-write that retires the rendition and
  // clears the hash BEFORE the bytes change, one post-write that records the
  // new hash, nothing enqueued by hand.
  it("clears the hash and rendition before the bytes change, then records the new hash", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    // How many version writes had landed when the bytes were replaced.
    let writesAtUpload = -1;
    storage.uploadFile.mockImplementation(async () => {
      writesAtUpload = fake.calls.filter(
        (call) => call.table === "document_versions",
      ).length;
    });

    const result = await run(fake.db);

    expect(result.ok).toBe(true);
    const versionWrites = fake.calls.filter(
      (call) => call.table === "document_versions",
    );
    expect(versionWrites).toHaveLength(2);
    // The clear goes first, so a crash after the upload leaves the version
    // unhashed (unverifiable, true) rather than attesting to old content.
    expect(versionWrites[0].payload).toEqual({
      content_sha256: null,
      pdf_storage_path: null,
    });
    expect(writesAtUpload).toBe(1);
    expect(versionWrites[1].payload).toEqual({
      content_sha256: expect.any(String),
    });
    // Scoped by the lifecycle helper, not by a raw id filter.
    for (const write of versionWrites)
      expect(write.filters).toEqual([
        ["eq", "id", "v1"],
        ["eq", "document_id", "doc-1"],
        ["is", "deleted_at", null],
      ]);
    // The keys ride on the trigger's rows instead of a job of their own.
    expect(dbq.enqueueStorageCleanup).not.toHaveBeenCalled();
    fake.done();
  });

  it("still removes the stale rendition inline when the queue is disabled", async () => {
    arrange();
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      // The lifecycle helper's pre-write snapshot of the keys about to retire.
      {
        table: "document_versions",
        data: {
          storage_path: "docs/v1.docx",
          pdf_storage_path: "renditions/v1.pdf",
          content_sha256: "old-hash",
        },
      },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { rpc: "document_cache_writer_active", data: false },
      { rpc: "document_cleanup_referenced_keys", data: [] },
      // Second write (the new hash): snapshot shows the rendition already gone.
      {
        table: "document_versions",
        data: {
          storage_path: "docs/v1.docx",
          pdf_storage_path: null,
          content_sha256: null,
        },
      },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { rpc: "document_cache_writer_active", data: false },
      { rpc: "document_cleanup_referenced_keys", data: [] },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);

    const result = await run(fake.db);

    expect(result.ok).toBe(true);
    // The rendition and the text cache go with the pre-write; the hash write
    // retires the (already gone) text cache again — an idempotent delete.
    expect(storage.deleteFile.mock.calls.flat()).toEqual([
      "renditions/v1.pdf",
      "extracted-text/v1.txt",
      "extracted-text/v1.txt",
    ]);
    expect(dbq.enqueueStorageCleanup).not.toHaveBeenCalled();
    fake.done();
  });

  // The bytes are already replaced by the time the hash is written, so a
  // failed write must leave the version UNHASHED — never with the old hash.
  it("leaves the version unhashed when the hash write fails", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      {
        table: "document_versions",
        op: "update",
        error: { message: "write failed" },
      },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);

    const result = await run(fake.db);

    expect(result.ok).toBe(true);
    const versionWrites = fake.calls.filter(
      (call) => call.table === "document_versions",
    );
    // Exactly the clear and the failed set: no compensating write is needed,
    // because the clear already happened before the bytes changed.
    expect(versionWrites).toHaveLength(2);
    expect(versionWrites[0].payload).toEqual({
      content_sha256: null,
      pdf_storage_path: null,
    });
    fake.done();
  });

  // Nothing has touched storage yet when the pre-write fails, so the right
  // answer is to refuse: the version stays intact and hashed.
  it("does not rewrite the bytes when the pre-write clear fails", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      {
        table: "document_versions",
        op: "update",
        error: { message: "write failed" },
      },
    ]);

    const result = await run(fake.db);

    expect(result.ok).toBe(false);
    // Carries the cause so the route answers 500, not the 404 a missing
    // edit gets: a client that retries on 5xx should retry this.
    expect(!result.ok && result.error).toEqual({ message: "write failed" });
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(
      fake.calls.filter((call) => call.table === "document_edits" && call.op === "update"),
    ).toHaveLength(0);
    fake.done();
  });
});
