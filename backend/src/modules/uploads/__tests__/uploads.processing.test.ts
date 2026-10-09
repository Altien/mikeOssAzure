import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";

const mocks = vi.hoisted(() => ({
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
}));

vi.mock("../../../lib/pdfText", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/pdfText")>()),
  countPagesWithoutText: mocks.countPagesWithoutText,
}));

vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/observability/sentry")>()),
  reportError: mocks.reportError,
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
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: mocks.createServerSupabase,
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
  }> = [];
  const next = () =>
    Promise.resolve(results.shift() ?? { data: null, error: null });

  class Query {
    private readonly call: (typeof calls)[number];
    constructor(table: string) {
      this.call = { table };
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

const baseFile = {
  id: "22222222-2222-4222-8222-222222222222",
  session_id: "11111111-1111-4111-8111-111111111111",
  resource_id: "33333333-3333-4333-8333-333333333333",
  client_id: "client-1",
  filename: "contract.pdf",
  file_type: "pdf",
  content_type: "application/pdf",
  expected_size_bytes: 4,
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
      Readable.from([Buffer.from([1, 2, 3, 4])]),
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
          p_payload: { kind: "document_create", size_bytes: 4 } });
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

  describe("editor-save compare-and-swap (sync 6e3ef6fa)", () => {
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sealedHash = createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex");
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

      claimError = missingRpc;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reports()).toHaveLength(2);
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
});
