import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";
const mocks = vi.hoisted(() => ({ download: vi.fn(), docx: vi.fn(), pdf: vi.fn(), convert: vi.fn(), sheet: vi.fn(), slides: vi.fn(), mammoth: vi.fn(), admit: vi.fn(), extract: vi.fn() }));
vi.mock("../../../lib/storage", () => ({ downloadFile: mocks.download }));
vi.mock("../../../lib/docxTrackedChanges", () => ({ extractDocxBodyText: mocks.docx }));
vi.mock("../../../lib/pdfText", () => ({ extractPdfTextForIndex: mocks.pdf }));
vi.mock("../../../lib/convert", () => ({ docxToPdf: mocks.convert }));
vi.mock("../../../lib/spreadsheet", () => ({ spreadsheetToLLMText: mocks.sheet }));
vi.mock("../../../lib/officeText", () => ({ extractPresentationText: mocks.slides }));
vi.mock("mammoth", () => ({ extractRawText: mocks.mammoth }));
vi.mock("../../../lib/extraction/isolated", async (original) => ({
  ...(await original<typeof import("../../../lib/extraction/isolated")>()), withBackgroundExtraction: mocks.admit,
}));
import { processClaimedJob } from "../../../lib/dbq/runner";
import { ExtractionLimitError, ExtractionBusyError } from "../../../lib/extraction/isolated";
const sentry = vi.hoisted(() => ({ reportError: vi.fn(), setOperation: vi.fn() }));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/observability/sentry")>();
  return { ...actual, reportError: sentry.reportError, setOperation: sentry.setOperation };
});
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";
import { extractDocumentText, handleDocumentExtractText, markDocumentTextFailed, backfillDocumentText, processDocumentTextInline } from "../documents.indexing";

const job = { id: "job", kind: "document.extract_text", payload: { versionId: "v1", revision: "r1" },
  status: "running", attempts: 1, max_attempts: 3, run_at: "", claimed_at: "2026-10-27T00:00:00Z",
  finished_at: null, last_error: null, dedupe_key: null, result: null, created_at: "",
  claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lease_expires_at: new Date(Date.now()+300_000).toISOString() } satisfies DbJob;
const bytes = new TextEncoder().encode("source bytes").buffer;
const version = { id: "v1", storage_path: "source", file_type: "docx", text_revision: "r1" };
const identity = { p_job_id: job.id, p_attempt: job.attempts, p_token: job.claim_token, p_version_id: "v1", p_revision: "r1" };
const current = (claimed: DbJob = job) => ({ table: "db_jobs", data: { ...claimed, lease_expires_at: new Date(Date.now()+300_000).toISOString() } });
const preparse = (source: Record<string, unknown> = version, claimed: DbJob = job) => [
  current(claimed), { table: "document_versions", data: source }, { rpc: "claim_document_text_job", data: true }, current(claimed), current(claimed),
];
const call = (fake: ReturnType<typeof scriptedDb>, name: string) => fake.calls.find((entry) => entry.table === name)!;
beforeEach(() => {
  vi.resetAllMocks(); mocks.download.mockResolvedValue(bytes); mocks.docx.mockResolvedValue("Complete clause\n\nAnother clause");
  mocks.extract.mockImplementation(async (_kind, raw, options) => extractDocumentText(raw, options.fileType));
  mocks.admit.mockImplementation(async (_options, work) => work(mocks.extract));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("version text extraction", () => {
  it("returns a busy claim through the canonical defer RPC without spending its last attempt", async () => {
    const claimed = { ...job, attempts: 3 };
    mocks.admit.mockRejectedValue(new ExtractionBusyError());
    const fake = scriptedDb([current(claimed), { rpc: "defer_db_job", data: true }]);
    await processClaimedJob(fake.db, { "document.extract_text": handleDocumentExtractText }, claimed);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(call(fake, "defer_db_job").args).toMatchObject({ p_id: claimed.id, p_attempts: 3, p_claim_token: claimed.claim_token, p_reason: "document_extraction_busy" });
    expect(fake.calls.some((entry) => entry.table === "finish_db_job")).toBe(false);
    expect(sentry.reportError).not.toHaveBeenCalled(); fake.done();
  });
  it("waits for inline admission and publishes through its canonical claim without a later sweep", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    mocks.admit.mockImplementationOnce(async (_options, work) => { await admitted; return work(mocks.extract); });
    const fake = scriptedDb([{ table: "db_jobs", data: [{ ...job, status: "pending" }] }, { rpc: "claim_db_job", data: [job] },
      ...preparse(), { rpc: "publish_document_text", data: true }, { rpc: "finish_db_job", data: true }]);
    const processing = processDocumentTextInline(fake.db);
    await vi.waitFor(() => expect(mocks.admit).toHaveBeenCalled());
    expect(mocks.download).not.toHaveBeenCalled(); release(); await processing;
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(call(fake, "finish_db_job").args).toMatchObject({ p_status: "done", p_attempts: 1, p_claim_token: job.claim_token }); fake.done();
  });
  it("publishes complete text against claim, revision and source hash, removing only unsupported NUL", async () => {
    mocks.docx.mockResolvedValue("Full\0 text\n" + "x".repeat(100000));
    const fake = scriptedDb([...preparse(), { rpc: "publish_document_text", data: true }]);
    await handleDocumentExtractText(fake.db, job);
    expect(call(fake, "document_versions").filters).toContainEqual(["eq", "text_revision", "r1"]);
    expect(call(fake, "claim_document_text_job").args).toEqual(identity);
    expect(call(fake, "publish_document_text").args).toEqual({ ...identity, p_text: "Full text\n" + "x".repeat(100000),
      p_sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"), p_textless_pages: null });
    expect(mocks.download).toHaveBeenCalledWith("source", expect.any(AbortSignal)); fake.done();
  });
  it("does not download superseded or deleted work", async () => {
    const fake = scriptedDb([current(), { table: "document_versions", data: null }]);
    await handleDocumentExtractText(fake.db, job); expect(mocks.download).not.toHaveBeenCalled(); fake.done();
  });
  it("skips a revision whose canonical claim is rejected", async () => {
    const fake = scriptedDb([current(), { table: "document_versions", data: version }, { rpc: "claim_document_text_job", data: false }]);
    await handleDocumentExtractText(fake.db, job); expect(mocks.download).not.toHaveBeenCalled();
    expect(call(fake, "claim_document_text_job").args).toEqual(identity); fake.done();
  });
  it("rejects source bytes that disagree with the persisted hash", async () => {
    const steps = preparse({ ...version, content_sha256: "different" }); steps.pop();
    const fake = scriptedDb(steps);
    await expect(handleDocumentExtractText(fake.db, job)).rejects.toThrow("source_changed");
    expect(mocks.extract).not.toHaveBeenCalled(); fake.done();
  });
  it("preserves successful empty extraction and OCR coverage", async () => {
    mocks.pdf.mockResolvedValue({ text: "", textlessPageCount: 4 });
    const fake = scriptedDb([...preparse({ ...version, file_type: "pdf" }), { rpc: "publish_document_text", data: true }]);
    await handleDocumentExtractText(fake.db, job);
    expect(call(fake, "publish_document_text").args).toMatchObject({ ...identity, p_text: "", p_textless_pages: 4 }); fake.done();
  });
  it("leaves a newer revision unchanged on fenced terminal failure", async () => {
    const fake = scriptedDb([{ rpc: "fail_document_text_job", data: false }]);
    await markDocumentTextFailed(fake.db, job);
    expect(fake.calls[0].args).toEqual({ ...identity, p_error_code: "extraction_failed", p_running: false }); fake.done();
  });
  it("fails a file over the download backstop without downloading it", async () => {
    const fake = scriptedDb([current(), { table: "document_versions", data: { ...version, size_bytes: 200*1024*1024 } },
      { rpc: "claim_document_text_job", data: true }, { rpc: "fail_document_text_job", data: true }]);
    await handleDocumentExtractText(fake.db, job);
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.extract).not.toHaveBeenCalled();
    expect(call(fake, "fail_document_text_job").args).toEqual({ ...identity, p_error_code: "too_large", p_running: true }); fake.done();
  });
  it("records a parser limit terminally on the owned revision instead of retrying", async () => {
    mocks.extract.mockRejectedValue(new ExtractionLimitError("parser deadline exceeded"));
    const fake = scriptedDb([...preparse({ ...version, file_type: "xlsx" }), { rpc: "fail_document_text_job", data: true }]);
    await handleDocumentExtractText(fake.db, job);
    expect(call(fake, "fail_document_text_job").args).toEqual({ ...identity, p_error_code: "too_large", p_running: true });
    expect(fake.calls.some((entry) => entry.table === "publish_document_text")).toBe(false); fake.done();
  });
  it("propagates extraction failure for canonical queue retries", async () => {
    mocks.docx.mockRejectedValue(new Error("invalid document"));
    const fake = scriptedDb(preparse());
    await expect(handleDocumentExtractText(fake.db, job)).rejects.toThrow("invalid document"); fake.done();
    expect(sentry.setOperation).toHaveBeenCalledWith("documents.extract"); expect(sentry.reportError).not.toHaveBeenCalled();
  });
  it.each(["xlsx", "xlsm", "xls"])("uses the full spreadsheet reader for %s", async (type) => {
    mocks.sheet.mockReturnValue("Sheet and cell addresses");
    expect(await extractDocumentText(bytes, type)).toEqual({ text: "Sheet and cell addresses", textlessPageCount: null });
  });
  it.each(["doc", "ppt"])("converts legacy %s then uses strict PDF extraction", async (type) => {
    mocks.convert.mockResolvedValue(Buffer.from("pdf")); mocks.pdf.mockResolvedValue({ text: "Pages", textlessPageCount: 0 });
    expect(await extractDocumentText(bytes, type)).toEqual({ text: "Pages", textlessPageCount: 0 });
  });
  it("extracts slides and rejects unsupported formats", async () => {
    mocks.slides.mockResolvedValue("## Slide 1\nWords");
    expect((await extractDocumentText(bytes, "pptx")).text).toContain("Words");
    await expect(extractDocumentText(bytes, "exe")).rejects.toThrow("unsupported_format");
  });
  it("schedules a bounded resumable backfill with explicit failure retries", async () => {
    const fake = scriptedDb([{ rpc: "backfill_document_text", data: 3 }]);
    expect(await backfillDocumentText(fake.db, { limit: 25, retryFailed: true })).toBe(3);
    expect(fake.calls[0].args).toEqual({ p_limit: 25, p_retry_failed: true }); fake.done();
  });

  it("processes saved content inline using claim and finish RPCs when the runner is disabled", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const fake = scriptedDb([{ table: "db_jobs", data: [{ ...job, status: "pending" }] }, { rpc: "claim_db_job", data: [job] },
      ...preparse(), { rpc: "publish_document_text", data: true }, { rpc: "finish_db_job", data: true }]);
    await processDocumentTextInline(fake.db, ["v1"]);
    expect(fake.calls[0].filters).toContainEqual(["in", "payload->>versionId", ["v1"]]);
    expect(call(fake, "claim_db_job").args).toMatchObject({ p_id: job.id });
    expect(call(fake, "finish_db_job").args).toMatchObject({ p_status: "done", p_attempts: job.attempts, p_claim_token: job.claim_token }); fake.done();
  });
  it("reports an inline terminal extraction failure once through the canonical runner", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const claimed = { ...job, attempts: 3 };
    const cause = Object.assign(new Error("PRIVATE_NAME.docx is corrupt"), { code: "ENOENT" });
    mocks.docx.mockRejectedValue(cause); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = scriptedDb([{ table: "db_jobs", data: [{ ...claimed, status: "pending" }] }, { rpc: "claim_db_job", data: [claimed] },
      ...preparse(version, claimed), { rpc: "finish_db_job", data: true }, { rpc: "fail_document_text_job", data: true }]);
    await processDocumentTextInline(fake.db, ["v1"]);
    expect(call(fake, "finish_db_job").args).toMatchObject({ p_status: "failed", p_attempts: 3, p_claim_token: job.claim_token });
    expect(call(fake, "fail_document_text_job").args).toMatchObject({ p_attempt: 3, p_token: job.claim_token, p_running: false }); fake.done();
    expect(sentry.reportError).toHaveBeenCalledOnce(); const [reported, context] = sentry.reportError.mock.calls[0]!;
    expect(reported).toBe(cause); expect(diagnosticErrorTags(reported)).toMatchObject({ failure_code: "ENOENT" });
    expect(context).toMatchObject({ tags: { component: "dbq", job_kind: "document.extract_text", terminal: true }, extra: { job_id: job.id } });
    expect(JSON.stringify(context)).not.toContain("PRIVATE_NAME");
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: cause }));
  });
  it("keeps an extractor's own kind when the canonical inline runner reports it", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const { AppError } = await import("../../../lib/appError.js");
    const cause = new AppError("extraction.pdf_parse_failed", "document_text_pdf_unreadable");
    mocks.pdf.mockRejectedValue(cause); vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = scriptedDb([{ table: "db_jobs", data: [{ ...job, status: "pending" }] }, { rpc: "claim_db_job", data: [job] },
      ...preparse({ ...version, file_type: "pdf" }), { rpc: "finish_db_job", data: true }]);
    await processDocumentTextInline(fake.db, ["v1"]); fake.done();
    expect(sentry.reportError).toHaveBeenCalledOnce();
    expect(diagnosticErrorTags(sentry.reportError.mock.calls[0]![0])).toEqual({ error_kind: "extraction.pdf_parse_failed" });
    expect(call(fake, "finish_db_job").args).toMatchObject({ p_status: "pending", p_attempts: 1, p_claim_token: job.claim_token });
  });
});
