import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";
import { MAX_EMAIL_NESTING_DEPTH } from "../../../lib/email";

const mocks = vi.hoisted(() => ({
  setOperation: vi.fn(),
  markStage: vi.fn(),
  deleteFile: vi.fn(),
  createFileReadStream: vi.fn(),
  copyFile: vi.fn(),
  officeFileToPdf: vi.fn(),
  recordAudit: vi.fn(),
  uploadFileFromPath: vi.fn(),
  createServerSupabase: vi.fn(),
  enqueueStorageCleanup: vi.fn(),
  requestDocumentCleanupDelivery: vi.fn(),
  reportError: vi.fn((_error: unknown, _context?: unknown) => null),
  countPagesWithoutText: vi.fn(async (_buf: ArrayBuffer): Promise<number | null> => null),
  createDocumentVersion: vi.fn(),
  updateDocumentVersion: vi.fn(),
}));

vi.mock("../../documents/documents.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../documents/documents.service")>()),
  createDocumentVersion: mocks.createDocumentVersion,
  updateDocumentVersion: mocks.updateDocumentVersion,
}));

vi.mock("../../../lib/pdfText", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/pdfText")>()),
  countPagesWithoutText: mocks.countPagesWithoutText,
}));

vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/observability/sentry")>()),
  reportError: mocks.reportError,
  setOperation: mocks.setOperation,
  markStage: mocks.markStage,
}));

vi.mock("../../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/storage")>();
  return {
    ...actual,
    deleteFile: mocks.deleteFile,
    // The best-effort wrapper resolves through the mocked delete so the
    // assertions on which objects were removed keep working.
    deleteFileBestEffort: (key: string) =>
      Promise.resolve(mocks.deleteFile(key)).catch(() => undefined),
    deleteFilesBestEffort: async (keys: Array<string | null | undefined>) => {
      for (const key of keys.filter(Boolean)) {
        await Promise.resolve(mocks.deleteFile(key)).catch(() => undefined);
      }
    },
    createFileReadStream: mocks.createFileReadStream,
    copyFile: mocks.copyFile,
    uploadFileFromPath: mocks.uploadFileFromPath,
  };
});

vi.mock("../../../lib/convert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/convert")>();
  return { ...actual, officeFileToPdf: mocks.officeFileToPdf };
});

vi.mock("../../../lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("../../../lib/dbq/enqueue", () => ({
  enqueueStorageCleanup: mocks.enqueueStorageCleanup,
  requestDocumentCleanupDelivery: mocks.requestDocumentCleanupDelivery,
}));
// The claim loop claims through the platform client (multi-tenant issue 003);
// both resolve to the test's fake.
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: mocks.createServerSupabase,
  createPlatformSupabase: mocks.createServerSupabase,
}));

import {
  cleanupUploadProcessingTempFiles,
  cleanupUploadSessions,
  processUploadJob,
  startUploadProcessingWorkers,
} from "../uploads.processing";

type QueryResult = { data?: unknown; error?: unknown };

function fakeDb(singleResults: Record<string, QueryResult[]> = {}) {
  class Query {
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    insert() {
      return this;
    }
    update() {
      return this;
    }
    upsert() {
      return this;
    }
    delete() {
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    not() {
      return this;
    }
    lt() {
      return this;
    }
    gte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      return Promise.resolve(
        singleResults[this.table]?.shift() ?? { data: null, error: null },
      );
    }
    maybeSingle() {
      return this.single();
    }
    then(resolve: (result: QueryResult) => unknown) {
      return Promise.resolve({ data: null, error: null }).then(resolve);
    }
  }

  return {
    from: vi.fn((table: string) => new Query(table)),
    rpc: vi.fn(async (name: string, args: { p_version?: Record<string, unknown> }): Promise<QueryResult> => name === "create_document_version"
      ? { data: { ...args.p_version, version_number: args.p_version?.version_number ?? 3 }, error: null }
      : { data: "processing", error: null }),
  };
}

function scriptedDb(results: QueryResult[]) {
  const calls: Array<{
    table: string;
    operation?: string;
    payload?: unknown;
    filters: unknown[][];
  }> = [];
  const next = () =>
    Promise.resolve(results.shift() ?? { data: null, error: null });

  class Query {
    private readonly call: (typeof calls)[number];
    constructor(table: string) {
      this.call = { table, filters: [] };
      calls.push(this.call);
    }
    select() {
      this.call.operation ??= "select";
      return this;
    }
    insert(payload: unknown) {
      this.call.operation = "insert";
      this.call.payload = payload;
      return this;
    }
    update(payload: unknown) {
      this.call.operation = "update";
      this.call.payload = payload;
      return this;
    }
    upsert(payload: unknown) {
      this.call.operation = "upsert";
      this.call.payload = payload;
      return this;
    }
    delete() {
      this.call.operation = "delete";
      return this;
    }
    eq(key: string, value: unknown) {
      this.call.filters.push(["eq", key, value]);
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    not() {
      return this;
    }
    lt() {
      return this;
    }
    gte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      return next();
    }
    maybeSingle() {
      return next();
    }
    then(resolve: (result: QueryResult) => unknown) {
      return next().then(resolve);
    }
  }

  return {
    from: vi.fn((table: string) => new Query(table)),
    rpc: vi.fn(async (name: string, args: { p_version?: Record<string, unknown> }): Promise<QueryResult> => name === "create_document_version"
      ? { data: { ...args.p_version, version_number: args.p_version?.version_number ?? 3 }, error: null }
      : { data: "processing", error: null }),
    calls,
    remaining: results,
  };
}

const pdfBytes = Buffer.from("%PDF-1.7\n");

const baseFile = {
  id: "22222222-2222-4222-8222-222222222222",
  session_id: "11111111-1111-4111-8111-111111111111",
  resource_id: "33333333-3333-4333-8333-333333333333",
  client_id: "client-1",
  filename: "contract.pdf",
  file_type: "pdf",
  content_type: "application/pdf",
  expected_size_bytes: pdfBytes.length,
  sealed_storage_path: "upload-sessions/user/session/file/sealed",
  target_folder_id: null,
  status: "uploaded",
  error_code: null,
  document_created_at: null as string | null,
};

const baseSession = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "44444444-4444-4444-8444-444444444444",
  user_email: "owner@example.com",
  purpose: "document_create" as const,
  destination: { scope: "standalone" },
  status: "processing",
};

describe("upload processing", () => {
  let processingTempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    processingTempRoot = await mkdtemp(join(tmpdir(), "mike-upload-test-"));
    process.env.UPLOAD_PROCESSING_TEMP_DIR = processingTempRoot;
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([pdfBytes]),
    );
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.officeFileToPdf.mockResolvedValue("/tmp/converted.pdf");
    mocks.uploadFileFromPath.mockResolvedValue(undefined);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.recordAudit.mockResolvedValue(undefined);
    mocks.enqueueStorageCleanup.mockResolvedValue(undefined);
    mocks.requestDocumentCleanupDelivery.mockResolvedValue(0);
  });

  afterEach(async () => {
    expect(await readdir(processingTempRoot)).toEqual([]);
    await rm(processingTempRoot, { recursive: true, force: true });
    delete process.env.UPLOAD_PROCESSING_TEMP_DIR;
  });

  it("prepares a sealed file then publishes only through the claim-token RPC", async () => {
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const db = scriptedDb([
      { data: { id: "job-1", session_id: baseSession.id, file_id: baseFile.id, attempts: 1, locked_by: "worker-1", claim_token: claimToken }, error: null },
      { data: baseSession, error: null },
      { data: baseFile, error: null },
    ]);
    db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "renew_upload_processing_job") return { data: true, error: null };
      if (name === "finish_upload_processing_job") {
        expect(args).toMatchObject({ p_token: claimToken, p_attempt: 1, p_failure: null,
          p_payload: { kind: "document_create", size_bytes: pdfBytes.length } });
        return { data: { status: "completed" }, error: null };
      }
      throw new Error("unexpected RPC: " + name);
    });
    await processUploadJob(db as never, "job-1", "worker-1");
    expect(mocks.copyFile).toHaveBeenCalledWith(baseFile.sealed_storage_path,
      expect.stringContaining(claimToken.replace(/-/g, "")));
    expect(db.calls.map(call => call.table)).toEqual([
      "upload_processing_jobs", "upload_sessions", "upload_session_files",
    ]);
    expect(mocks.recordAudit).toHaveBeenCalledOnce();
  });

  // Sync cf5fa985: the worker measures textless PDF pages and hands the count
  // to the publishing RPC (0104), which stores it on the version row.
  it.each([
    ["pdf", "contract.pdf", 3, 3],
    ["docx", "contract.docx", 3, null],
  ])("puts textless_page_count for a %s upload in the publish payload", async (
    fileType, filename, measured, expected,
  ) => {
    mocks.countPagesWithoutText.mockImplementation(async () => measured);
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const file = { ...baseFile, file_type: fileType, filename };
    const db = scriptedDb([
      { data: { id: "job-1", session_id: baseSession.id, file_id: baseFile.id, attempts: 1, locked_by: "worker-1", claim_token: claimToken }, error: null },
      { data: baseSession, error: null },
      { data: file, error: null },
    ]);
    let payload: Record<string, unknown> | undefined;
    db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "renew_upload_processing_job") return { data: true, error: null };
      if (name === "finish_upload_processing_job") {
        payload = args.p_payload as Record<string, unknown>;
        return { data: { status: "completed" }, error: null };
      }
      throw new Error("unexpected RPC: " + name);
    });
    await processUploadJob(db as never, "job-1", "worker-1");
    expect(payload).toMatchObject({ kind: "document_create", textless_page_count: expected });
    expect(mocks.countPagesWithoutText).toHaveBeenCalledTimes(fileType === "pdf" ? 1 : 0);
  });

  describe("an uploaded email", () => {
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const emailFile = {
      ...baseFile,
      filename: "Deal.eml.md",
      // Real email uploads carry file_type "eml"; a "pdf" fixture would now
      // fail the PDF header check (upstream ceedace6).
      file_type: "eml",
      content_type: "message/rfc822",
    };
    const placement = {
      user_id: baseSession.user_id, project_id: "55555555-5555-4555-8555-555555555555",
      folder_id: "66666666-6666-4666-8666-666666666666", library_kind: "file",
      library_folder_id: null, workflow_id: null, org_id: null,
    };

    function part(filename: string, contentType: string, body: string): string {
      return [
        `Content-Type: ${contentType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(body).toString("base64"),
      ].join("\r\n");
    }

    function emlPart(filename: string, raw: string): string {
      return ["Content-Type: message/rfc822", `Content-Disposition: attachment; filename="${filename}"`, "", raw].join("\r\n");
    }

    function message(subject: string, parts: string[]): string {
      const boundary = `b-${subject.replace(/\W/g, "")}`;
      const lines = [
        "From: ann@example.com", "To: bob@example.com", `Subject: ${subject}`, "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
        `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", `Body of ${subject}`,
      ];
      for (const item of parts) lines.push(`--${boundary}`, item);
      lines.push(`--${boundary}--`, "");
      return lines.join("\r\n");
    }

    async function runEmail(raw: string) {
      const bytes = Buffer.from(raw);
      mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
      const stored: Array<{ key: string; contentType: string; content: Buffer }> = [];
      mocks.uploadFileFromPath.mockImplementation(async (key: string, path: string, contentType: string) => {
        stored.push({ key, contentType, content: await readFile(path) });
      });
      mocks.officeFileToPdf.mockImplementation(async (_input: string, directory: string) => {
        const output = join(directory, "converted.pdf");
        await writeFile(output, "%PDF-1.4\n%%EOF\n");
        return output;
      });
      mocks.updateDocumentVersion.mockResolvedValue({ data: { id: emailFile.id }, error: null });
      mocks.createDocumentVersion.mockImplementation(async (_db: unknown, version: Record<string, unknown>) =>
        ({ data: { ...version, version_number: 1 }, error: null }));
      const file = { ...emailFile, expected_size_bytes: bytes.byteLength };
      const db = scriptedDb([
        { data: { id: "job-1", session_id: baseSession.id, file_id: file.id, attempts: 1, locked_by: "worker-1", claim_token: claimToken }, error: null },
        { data: baseSession, error: null },
        { data: file, error: null },
        { data: null, error: null }, // upload_session_files result update
        { data: placement, error: null }, // the published email's placement
      ]);
      let payload: Record<string, unknown> | undefined;
      db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name === "renew_upload_processing_job") return { data: true, error: null };
        if (name === "finish_upload_processing_job") {
          payload = args.p_payload as Record<string, unknown>;
          return { data: { status: "completed", result: { id: file.resource_id, file_type: "pdf" } }, error: null };
        }
        throw new Error("unexpected RPC: " + name);
      });
      await processUploadJob(db as never, "job-1", "worker-1");
      return { db, stored, payload: payload!, size: bytes.byteLength };
    }

    it("stores the Markdown it converts to and gives the version its real type and size", async () => {
      const { db, stored, payload, size } = await runEmail(message("Deal", []));

      const markdown = stored.find((item) => item.key === payload.source_path)!;
      expect(markdown.contentType).toBe("text/markdown; charset=utf-8");
      expect(markdown.content.toString()).toContain("Body of Deal");
      expect(payload).toMatchObject({
        kind: "document_create", pdf_path: null, page_count: null, size_bytes: size,
        sha256: createHash("sha256").update(markdown.content).digest("hex"),
      });
      expect(String(payload.source_path)).toMatch(/\.md$/);
      expect(mocks.copyFile).not.toHaveBeenCalled();
      expect(mocks.updateDocumentVersion).toHaveBeenCalledWith(db, emailFile.resource_id, emailFile.id,
        { file_type: "md", size_bytes: markdown.content.byteLength });
      const resultUpdate = db.calls.find((call) => call.table === "upload_session_files" && call.operation === "update");
      expect(resultUpdate?.payload).toEqual({
        result: { id: emailFile.resource_id, file_type: "md", size_bytes: markdown.content.byteLength },
      });
      expect(mocks.createDocumentVersion).not.toHaveBeenCalled();
    });

    it("imports each supported attachment as a document beside the email", async () => {
      const inner = message("Inner", [part("schedule.pdf", "application/pdf", "%PDF-1.4 inner")]);
      const raw = message("Deal", [
        part("SPA.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx bytes"),
        part("cover.pdf", "application/pdf", "%PDF-1.4 cover"),
        part("tool.exe", "application/octet-stream", "MZ"),
        emlPart("Fwd.eml", inner),
      ]);
      const { db, stored, payload } = await runEmail(raw);

      const emailMarkdown = stored.find((item) => item.key === payload.source_path)!.content.toString();
      expect(emailMarkdown).toContain('SPA.docx (10 B): imported as document "Deal.eml - SPA.docx"');
      expect(emailMarkdown).toContain("tool.exe (2 B): not imported: unsupported type");
      expect(emailMarkdown).toContain('imported as document "Deal.eml - Fwd.eml.md"');

      const versions = mocks.createDocumentVersion.mock.calls.map(([, version]) => version as Record<string, unknown>);
      expect(versions.map((version) => [version.filename, version.file_type])).toEqual([
        ["Deal.eml - SPA.docx", "docx"],
        ["Deal.eml - cover.pdf", "pdf"],
        ["Deal.eml - Fwd.eml.md", "md"],
        ["Deal.eml - Fwd.eml - schedule.pdf", "pdf"],
      ]);
      for (const version of versions) {
        expect(version.source).toBe("upload");
        const source = stored.find((item) => item.key === version.storage_path)!;
        expect(version.size_bytes).toBe(source.content.byteLength);
        expect(version.content_sha256).toBe(createHash("sha256").update(source.content).digest("hex"));
      }
      // The Word attachment gets the PDF rendition an upload would; a PDF is its own.
      expect(versions[0].pdf_storage_path).toEqual(expect.stringContaining("converted"));
      expect(versions[1].pdf_storage_path).toBe(versions[1].storage_path);
      expect(stored.find((item) => item.key === versions[2].storage_path)!.content.toString())
        .toContain('schedule.pdf (14 B): imported as document "Deal.eml - Fwd.eml - schedule.pdf"');

      const inserted = db.calls.filter((call) => call.table === "documents" && call.operation === "insert");
      expect(inserted).toHaveLength(4);
      for (const call of inserted) expect(call.payload).toMatchObject({ ...placement, status: "ready" });
      // The email and each of its four documents.
      expect(mocks.recordAudit).toHaveBeenCalledTimes(5);
    });

    it("imports emails nested inside emails no deeper than the cap", async () => {
      let raw = message("Level5", []);
      for (let level = 4; level >= 0; level -= 1) {
        const subject = `Level${level}`;
        raw = message(subject, [emlPart(`l${level + 1}.eml`, raw)]);
      }
      const { stored } = await runEmail(raw);

      const versions = mocks.createDocumentVersion.mock.calls.map(([, version]) => version as Record<string, unknown>);
      expect(versions.map((version) => version.filename)).toEqual([
        "Deal.eml - l1.eml.md",
        "Deal.eml - l1.eml - l2.eml.md",
        "Deal.eml - l1.eml - l2.eml - l3.eml.md",
      ]);
      expect(versions).toHaveLength(MAX_EMAIL_NESTING_DEPTH);
      const deepest = stored.find((item) => item.key === versions.at(-1)!.storage_path)!;
      expect(deepest.content.toString()).toContain("l4.eml (");
      expect(deepest.content.toString()).toContain("not imported: emails nested too deeply");
    });
  });

  it("sends a failed file to the atomic retry RPC without publishing domain rows", async () => {
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from(
        (async function* () {
          throw new Error("sealed object unavailable");
        })(),
      ),
    );
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          file_id: baseFile.id,
          attempts: 1,
          locked_by: "worker-1",
          claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        error: null,
      },
      { data: baseSession, error: null },
      { data: baseFile, error: null },
    ]);
    db.rpc.mockImplementation(async (name: string) => ({
      data: name === "renew_upload_processing_job" ? true : { status: "retry" },
      error: null,
    }));

    await processUploadJob(db as never, "job-1", "worker-1");

    expect(db.rpc).toHaveBeenCalledWith("finish_upload_processing_job", expect.objectContaining({
      p_failure: "processing_failed", p_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    expect(db.calls.map((call) => call.table)).toEqual([
      "upload_processing_jobs", "upload_sessions", "upload_session_files",
    ]);
    expect(db.remaining).toHaveLength(0);
  });

  // Upstream ceedace6: PDF uploads must carry a PDF header. Dev publishes
  // through the claim-token RPC, so an invalid file is finished terminally
  // with p_failure "invalid_pdf_file" (migration 0243) before any copy.
  function pdfHeaderJob(bytes: Buffer) {
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = scriptedDb([
      { data: { id: "job-1", session_id: baseSession.id, file_id: baseFile.id, attempts: 1,
        locked_by: "worker-1", claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null },
      { data: baseSession, error: null },
      { data: { ...baseFile, expected_size_bytes: bytes.length }, error: null },
    ]);
    const failures: unknown[] = [];
    db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "renew_upload_processing_job") return { data: true, error: null };
      if (name === "finish_upload_processing_job") {
        failures.push(args.p_failure);
        return { data: args.p_failure ? { status: "error" } : { status: "completed" }, error: null };
      }
      throw new Error("unexpected RPC: " + name);
    });
    return { db, failures };
  }

  it.each(["", " \t\r\n\f", "\uFEFF", " \n\uFEFF\t"])(
    "accepts a PDF header with leading prefix %j",
    async (prefix) => {
      const { db, failures } = pdfHeaderJob(Buffer.concat([Buffer.from(prefix), pdfBytes]));
      await processUploadJob(db as never, "job-1", "worker-1");
      expect(failures).toEqual([null]);
      expect(mocks.copyFile).toHaveBeenCalledOnce();
    },
  );

  it.each(["", "plain text", "PK\u0003\u0004Office bytes", "%PDF", "junk%PDF-1.7", " \uFEFF\n"])(
    "finishes non-PDF bytes %j terminally before destination writes",
    async (content) => {
      const { db, failures } = pdfHeaderJob(Buffer.from(content));
      await processUploadJob(db as never, "job-1", "worker-1");
      expect(failures).toEqual(["invalid_pdf_file"]);
      expect(mocks.copyFile).not.toHaveBeenCalled();
      expect(mocks.uploadFileFromPath).not.toHaveBeenCalled();
      expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
      expect(mocks.recordAudit).not.toHaveBeenCalled();
      expect(db.remaining).toHaveLength(0);
    },
  );

  describe("editor-save compare-and-swap (sync 6e3ef6fa)", () => {
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sealedHash = createHash("sha256").update(pdfBytes).digest("hex");
    const startedFrom = "a".repeat(64);
    const replaceSession = {
      ...baseSession,
      purpose: "document_version_replace" as const,
      destination: {
        document_id: baseFile.resource_id,
        version_id: "55555555-5555-4555-8555-555555555555",
        expected_content_sha256: startedFrom,
        generate_pdf: false,
      },
    };
    const docxFile = { ...baseFile, filename: "contract.docx", file_type: "docx",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    const job = { id: "job-1", session_id: baseSession.id, file_id: baseFile.id, attempts: 1,
      locked_by: "worker-1", claim_token: claimToken };

    it("passes the observed baseline to the publish RPC and skips the PDF rendition", async () => {
      const db = scriptedDb([
        { data: job, error: null },
        { data: replaceSession, error: null },
        { data: docxFile, error: null },
        { data: { storage_path: "documents/old.docx", content_sha256: startedFrom }, error: null },
      ]);
      db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name === "renew_upload_processing_job") return { data: true, error: null };
        expect(args).toMatchObject({ p_failure: null, p_payload: {
          kind: "document_version_replace",
          expected_storage_path: "documents/old.docx",
          expected_content_sha256: startedFrom,
          pdf_path: null,
          sha256: sealedHash,
        } });
        return { data: { status: "completed" }, error: null };
      });
      await processUploadJob(db as never, "job-1", "worker-1");
      expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
      expect(mocks.copyFile).toHaveBeenCalledOnce();
    });

    it("fails terminally as document_changed before staging when the version moved on", async () => {
      const db = scriptedDb([
        { data: job, error: null },
        { data: replaceSession, error: null },
        { data: docxFile, error: null },
        { data: { storage_path: "documents/newer.docx", content_sha256: "b".repeat(64) }, error: null },
      ]);
      db.rpc.mockImplementation(async (name: string) => ({
        data: name === "renew_upload_processing_job" ? true : { status: "error", error_code: "document_changed" },
        error: null,
      }));
      await processUploadJob(db as never, "job-1", "worker-1");
      expect(db.rpc).toHaveBeenCalledWith("finish_upload_processing_job", expect.objectContaining({
        p_failure: "document_changed", p_payload: null,
      }));
      expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it("hashes an unhashed legacy version from storage before comparing", async () => {
      const db = scriptedDb([
        { data: job, error: null },
        { data: { ...replaceSession, destination: { ...replaceSession.destination,
          expected_content_sha256: sealedHash } }, error: null },
        { data: docxFile, error: null },
        { data: { storage_path: "documents/legacy.docx", content_sha256: null }, error: null },
      ]);
      db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name === "renew_upload_processing_job") return { data: true, error: null };
        expect(args).toMatchObject({ p_failure: null, p_payload: {
          expected_storage_path: "documents/legacy.docx", expected_content_sha256: null } });
        return { data: { status: "completed" }, error: null };
      });
      await processUploadJob(db as never, "job-1", "worker-1");
      expect(mocks.createFileReadStream).toHaveBeenCalledWith("documents/legacy.docx");
    });

    it("treats a lost publish comparison as a recorded terminal outcome", async () => {
      const db = scriptedDb([
        { data: job, error: null },
        { data: replaceSession, error: null },
        { data: docxFile, error: null },
        { data: { storage_path: "documents/old.docx", content_sha256: startedFrom }, error: null },
      ]);
      db.rpc.mockImplementation(async (name: string) => ({
        data: name === "renew_upload_processing_job" ? true : { status: "error", error_code: "document_changed" },
        error: null,
      }));
      await expect(processUploadJob(db as never, "job-1", "worker-1")).resolves.toBeUndefined();
      expect(db.rpc).toHaveBeenCalledTimes(3);
    });
  });

  it("names a job, session or file row that is no longer there (MIKE-BACKEND-M)", async () => {
    const job = {
      id: "job-1",
      session_id: baseSession.id,
      file_id: baseFile.id,
      attempts: 1,
      locked_by: "worker-1",
      // Dev: the claim lookup also requires the claim-token fence.
      claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const cases: Array<{ results: QueryResult[]; kind: string; message: string }> = [
      { results: [{ data: null, error: null }], kind: "upload.job_missing", message: "upload_job_not_found" },
      {
        results: [{ data: job, error: null }, { data: null, error: null }],
        kind: "upload.session_missing",
        message: "upload_session_not_found",
      },
      {
        results: [{ data: job, error: null }, { data: baseSession, error: null }, { data: null, error: null }],
        kind: "upload.file_missing",
        message: "upload_session_file_not_found",
      },
    ];
    for (const { results, kind, message } of cases) {
      const db = scriptedDb(results);
      const thrown = await processUploadJob(db as never, "job-1", "worker-1").then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(message);
      expect(diagnosticErrorTags(thrown).error_kind).toBe(kind);
    }
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
  });

  it("keeps a database failure on the lookup as the failure, with its code", async () => {
    const db = scriptedDb([{ data: null, error: { code: "57014", message: "canceling statement" } }]);
    const thrown = await processUploadJob(db as never, "job-1", "worker-1").then(
      () => null,
      (error: unknown) => error,
    );
    expect(diagnosticErrorTags(thrown).failure_code).toBe("57014");
    expect(diagnosticErrorTags(thrown).error_kind).toBeUndefined();
  });

  it("stops before processing when the database lease has been lost", async () => {
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          file_id: baseFile.id,
          attempts: 1,
          locked_by: "worker-1",
          claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        error: null,
      },
      { data: baseSession, error: null },
      { data: baseFile, error: null },
    ]);
    db.rpc.mockResolvedValue({ data: false, error: null });

    await expect(
      processUploadJob(db as never, "job-1", "worker-1"),
    ).rejects.toThrow("upload_job_lease_lost");
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
  });

  it("removes stale temporary upload directories left by an interrupted worker", async () => {
    const staleDirectory = join(processingTempRoot, "mike-upload-stale");
    await mkdir(staleDirectory);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(staleDirectory, twoHoursAgo, twoHoursAgo);

    await cleanupUploadProcessingTempFiles();

    expect(await readdir(processingTempRoot)).toEqual([]);
  });

  it("starts the configured number of claim loops with the per-user cap", async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    db.rpc.mockResolvedValue({ data: null, error: null });
    mocks.createServerSupabase.mockReturnValue(db);

    const stop = startUploadProcessingWorkers({
      concurrency: 16,
      maxRunningPerUser: 4,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(
          db.rpc.mock.calls.filter(
            ([name]) => name === "claim_upload_processing_job",
          ),
        ).toHaveLength(16);
      });
      const claimCalls = db.rpc.mock.calls.filter(
        ([name]) => name === "claim_upload_processing_job",
      );
      expect(claimCalls).toEqual(
        expect.arrayContaining([
          [
            "claim_upload_processing_job",
            expect.objectContaining({ target_max_running_per_user: 4 }),
          ],
        ]),
      );
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("reports a claim loop that fails every tick once, with its code, and backs off (MIKE-BACKEND-K)", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const missingRpc = {
      code: "PGRST202",
      message: "Could not find the function public.claim_upload_processing_job",
      details: null,
      hint: null,
    };
    let claimError: typeof missingRpc | null = missingRpc;
    const db = fakeDb();
    db.rpc.mockImplementation(async (name: string) =>
      name === "claim_upload_processing_job" && claimError
        ? { data: null, error: claimError }
        : { data: null, error: null },
    );
    mocks.createServerSupabase.mockReturnValue(db);
    const claims = () =>
      db.rpc.mock.calls.filter(([name]) => name === "claim_upload_processing_job")
        .length;
    const reports = () =>
      mocks.reportError.mock.calls.filter(
        ([, context]) =>
          (context as { tags?: { component?: string } } | undefined)?.tags
            ?.component === "upload-worker",
      );

    const stop = startUploadProcessingWorkers({
      concurrency: 2,
      maxRunningPerUser: 1,
    });
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // One report for the process, not one per tick per loop (~600).
      expect(reports()).toHaveLength(1);
      const [reported] = reports()[0];
      expect(reported).toBeInstanceOf(Error);
      expect(diagnosticErrorTags(reported).failure_code).toBe("PGRST202");
      // The console copy carries the same object, so the bridge dedupes it.
      const logged = consoleError.mock.calls.filter(
        ([label]) => label === "[upload-worker] iteration failed",
      );
      expect(logged).toHaveLength(1);
      expect((logged[0][1] as { error: unknown }).error).toBe(reported);
      // Backed off to the 30 s ceiling instead of polling every second.
      expect(claims()).toBeLessThan(40);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[upload-worker\] iteration still failing \(Error:PGRST202\)/),
      );

      claimError = null;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/^\[upload-worker\] iteration recovered after \d+ consecutive failure/),
      );

      // The same failure returning minutes after it was reported is a flap,
      // not news: one event per class per window, however often it recurs.
      claimError = missingRpc;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reports()).toHaveLength(1);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[upload-worker\] iteration failing again \(Error:PGRST202\)/),
      );

      // A different failure class is reported at once.
      claimError = null;
      await vi.advanceTimersByTimeAsync(31_000);
      claimError = { ...missingRpc, code: "40P01", message: "deadlock detected" };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reports()).toHaveLength(2);
      expect(diagnosticErrorTags(reports()[1][0]).failure_code).toBe("40P01");
    } finally {
      stop();
      vi.useRealTimers();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it("expires stale sessions, queues durable cleanup, and deletes retained rows", async () => {
    const db = scriptedDb([
      { error: null },
      { error: null },
      { data: [{ id: "session-clean" }], error: null },
      { data: [{ id: "old-session" }], error: null },
      { error: null },
    ]);

    await cleanupUploadSessions(db as never);

    expect(db.rpc).toHaveBeenCalledWith("queue_upload_session_cleanup", { p_session_id: "session-clean" });
    expect(db.rpc).toHaveBeenCalledWith("expire_exhausted_upload_jobs", {
      p_lease_seconds: 1800, p_limit: 20,
    });
    expect(db.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "upload_sessions",
          operation: "delete",
        }),
      ]),
    );
    expect(db.remaining).toHaveLength(0);
  });


  // Workspace assignment belongs to the locked session in the finish RPC,
  // never to a JavaScript upsert or an override in the prepared payload.
  describe("workspace publication through the session claim", () => {
    const ORG = "66666666-6666-4666-8666-666666666666";
    it.each([
      ["standalone team", { scope: "standalone", org_id: ORG }],
      ["library team", { scope: "library", library_kind: "file", org_id: ORG }],
      ["Personal", { scope: "standalone" }],
    ])("publishes %s using the exact locked session and no client workspace override", async (_label, destination) => {
      const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const db = scriptedDb([
        { data: { id: "job-1", session_id: baseSession.id, file_id: baseFile.id,
          attempts: 1, locked_by: "worker-1", claim_token: claimToken }, error: null },
        { data: { ...baseSession, destination }, error: null },
        { data: baseFile, error: null },
      ]);
      db.rpc.mockImplementation(async (name: string) => ({
        data: name === "renew_upload_processing_job" ? true : { status: "completed" }, error: null,
      }));
      await processUploadJob(db as never, "job-1", "worker-1");
      expect(db.calls.map((call) => call.table)).toEqual([
        "upload_processing_jobs", "upload_sessions", "upload_session_files",
      ]);
      expect(db.calls[1].filters).toContainEqual(["eq", "id", baseSession.id]);
      expect(db.rpc).toHaveBeenCalledWith("finish_upload_processing_job", expect.objectContaining({
        p_job_id: "job-1", p_worker_id: "worker-1", p_attempt: 1, p_token: claimToken,
        p_failure: null, p_payload: expect.objectContaining({ kind: "document_create", project_id: null }),
      }));
      const payload = (db.rpc.mock.calls.find(([name]) => name === "finish_upload_processing_job")![1] as unknown as { p_payload: Record<string, unknown> }).p_payload;
      expect(payload).not.toHaveProperty("org_id");
      expect(payload).not.toHaveProperty("user_id");
      expect(db.remaining).toHaveLength(0);
    });
  });
});
