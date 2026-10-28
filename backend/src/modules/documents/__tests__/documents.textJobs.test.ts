import { beforeEach, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { DbJobDeferredError, type DbJob } from "../../../lib/dbq/types";
const mocks = vi.hoisted(() => ({ inline: vi.fn(), downloadFile: vi.fn(), uploadFile: vi.fn(), setOperation: vi.fn() }));
vi.mock("../documents.indexing", async (original) => ({
  ...(await original<typeof import("../documents.indexing")>()), processDocumentTextInline: mocks.inline,
}));
vi.mock("../../../lib/storage", () => ({ downloadFile: mocks.downloadFile, uploadFile: mocks.uploadFile }));
vi.mock("../../../lib/observability/sentry", async (original) => ({
  ...(await original<typeof import("../../../lib/observability/sentry")>()), setOperation: mocks.setOperation,
}));
import { handleDocumentPrecomputeText } from "../documents.textJobs";
const job = {
  payload: { versionId: "v", storagePath: "old-source", fileType: "doc" },
  id: "text-job", kind: "document.precompute_text", status: "running", attempts: 1,
  max_attempts: 3, run_at: "", claimed_at: null, finished_at: null, last_error: null,
  dedupe_key: null, result: null, created_at: "",
  claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
} satisfies DbJob;
const enqueue = { p_version_id: "v", p_retry_failed: false,
  p_precompute_job: { id: job.id, attempt: job.attempts, token: job.claim_token } };
beforeEach(() => { vi.resetAllMocks(); mocks.inline.mockResolvedValue(undefined); });
it("leaves deleted or replaced version eligibility to the canonical guarded queue", async () => {
  const fake = scriptedDb([{ rpc: "queue_document_text", data: false }]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(fake.calls[0].args).toEqual(enqueue);
  expect(mocks.downloadFile).not.toHaveBeenCalled(); expect(mocks.uploadFile).not.toHaveBeenCalled(); fake.done();
});
it("never creates a fixed-key output that can outlive a source revision", async () => {
  const fake = scriptedDb([{ rpc: "queue_document_text", data: true }]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(mocks.inline).toHaveBeenCalledWith(fake.db, ["v"]);
  expect(mocks.uploadFile).not.toHaveBeenCalled(); fake.done();
});
it("names its operation before guarded enqueueing", async () => {
  const fake = scriptedDb([{ rpc: "queue_document_text", data: true }]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(mocks.setOperation).toHaveBeenCalledWith("documents.precompute_text"); fake.done();
});
it("does not start extraction when guarded enqueue cannot establish current access", async () => {
  const error = new Error("database unavailable");
  const fake = scriptedDb([{ rpc: "queue_document_text", error }]);
  await expect(handleDocumentPrecomputeText(fake.db, job)).rejects.toBe(error);
  expect(mocks.inline).not.toHaveBeenCalled(); expect(mocks.uploadFile).not.toHaveBeenCalled(); fake.done();
});
it("rejects an unfenced legacy job before any queue or storage mutation", async () => {
  const fake = scriptedDb([]);
  await expect(handleDocumentPrecomputeText(fake.db, { ...job, claim_token: null })).rejects.toThrow("no claim fence");
  expect(mocks.inline).not.toHaveBeenCalled(); expect(mocks.uploadFile).not.toHaveBeenCalled(); fake.done();
});
it("propagates canonical resource-busy deferral without creating a cache", async () => {
  const fake = scriptedDb([{ rpc: "queue_document_text", data: true }]);
  const deferred = new DbJobDeferredError(new Date(Date.now() + 30_000).toISOString(), "document_extraction_busy");
  mocks.inline.mockRejectedValue(deferred);
  await expect(handleDocumentPrecomputeText(fake.db, job)).rejects.toBe(deferred);
  expect(mocks.uploadFile).not.toHaveBeenCalled(); fake.done();
});
it("delegates parser limits and terminal revision publication to the canonical extractor", async () => {
  const fake = scriptedDb([{ rpc: "queue_document_text", data: true }]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(fake.calls[0].args).toEqual(enqueue);
  expect(mocks.inline).toHaveBeenCalledOnce(); expect(mocks.uploadFile).not.toHaveBeenCalled(); fake.done();
});
