import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../../test/helpers/fakeDb";
import { verificationProposalSchema } from "./schemas";
import { verifyResolvedProposal } from "./verify";

const { downloadFileMock, uploadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
  uploadFileMock: vi.fn(),
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

import { exportCitationReview } from "./exportService";

const encoder = new TextEncoder();
const memoText = "Example v Example confirms the rule.";
const sourceText = "Header\n\nThe court adopted the rule.";

function verified() {
  return verifyResolvedProposal({
    proposal: verificationProposalSchema.parse({
      schema_version: 1,
      memo: { document_id: "memo-id", version_id: "memo-v1" },
      sources: {
        authority: {
          document_id: "source-id",
          version_id: "source-v1",
          title: "Authority",
          kind: "case",
        },
      },
      citations: [
        {
          id: "c001",
          source_candidates: ["authority"],
          cite_text: "Example v Example",
          proposition: "The rule applies.",
          support_type: "quotation",
          anchors_proposed: [
            { source: "authority", quote: "The court adopted the rule." },
          ],
        },
      ],
    }),
    memo: {
      documentId: "memo-id",
      versionId: "memo-v1",
      filename: "memo.md",
      bytes: encoder.encode(memoText),
    },
    sources: {
      authority: {
        documentId: "source-id",
        versionId: "source-v1",
        filename: "authority.md",
        bytes: encoder.encode(sourceText),
      },
    },
  });
}

function database(options?: {
  runProjectId?: string;
  projectOwnerId?: string;
  sharedWith?: string[];
  profileEmail?: string | null;
}) {
  const result = verified();
  const respond = (call: DbCall) => {
    if (call.table === "citation_verification_runs") {
      if (call.columns === "id") return { data: [{ id: "run-1" }] };
      return {
        data: [
          {
            id: "run-1",
            project_id: options?.runProjectId ?? "project-1",
            verified_record: result.record,
            report: result.report,
            created_at: "2026-07-25T12:00:00.000Z",
          },
        ],
      };
    }
    if (call.table === "user_profiles") {
      return {
        data: [{ email: options?.profileEmail ?? "user@example.com" }],
      };
    }
    if (call.table === "projects") {
      return {
        data: [
          {
            id: "project-1",
            user_id: options?.projectOwnerId ?? "user-1",
            shared_with: options?.sharedWith ?? [],
          },
        ],
      };
    }
    // Dev drift: project sharing moved from projects.shared_with to
    // project_access_grants rows (email + role), read by lib/access.
    if (call.table === "project_access_grants") {
      const email = call.filters.find(
        (filter) => filter[0] === "eq" && filter[1] === "email",
      )?.[2];
      const shared = (options?.sharedWith ?? []).some(
        (entry) => entry.toLowerCase() === email,
      );
      return { data: shared ? [{ role: "viewer" }] : [] };
    }
    if (call.table === "documents" && call.op === "select") {
      return { data: [{ id: "memo-id" }, { id: "source-id" }] };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return {
        data: [
          {
            id: "memo-v1",
            document_id: "memo-id",
            storage_path: "memo/path",
            filename: "memo.md",
          },
          {
            id: "source-v1",
            document_id: "source-id",
            storage_path: "source/path",
            filename: "authority.md",
          },
        ],
      };
    }
    return { data: [] };
  };
  return makeFakeDb(respond);
}

function exportInput(overrides?: { runId?: string }) {
  return {
    runId: overrides?.runId ?? "run-1",
    userId: "user-1",
    projectId: "project-1",
  };
}

beforeEach(() => {
  uploadFileMock.mockReset().mockResolvedValue(undefined);
  downloadFileMock
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "memo/path"
        ? encoder.encode(memoText).buffer
        : encoder.encode(sourceText).buffer,
    );
});

describe("exportCitationReview", () => {
  it("returns a download reference and a run summary, never the report body", async () => {
    const { db } = database();

    const result = await exportCitationReview(exportInput(), db as never);

    expect(result).toMatchObject({
      ok: true,
      run_id: "run-1",
      export_type: "review",
      filename: "authority-trace-run-1-review.html",
      integrity: "ok",
      citations: { total: 1, anchored: 1, failed: 0 },
      reviews: { current_verdicts: 0, stale_verdicts: 0 },
    });
    expect(result).toMatchObject({
      download_url: expect.stringMatching(/^\/download\/[\w-]+\.[\w-]+$/),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain("Authority Trace offline review");

    const [storagePath, uploaded, contentType] = uploadFileMock.mock.calls[0];
    expect(String(storagePath)).toContain("/versions/");
    expect(contentType).toBe("text/html; charset=utf-8");
    expect(
      new TextDecoder().decode(uploaded as ArrayBuffer),
    ).toContain("Authority Trace offline review");
  });

  it("records the report as a downloadable document without touching the run", async () => {
    const { db, calls } = database();

    await exportCitationReview(exportInput(), db as never);

    expect(calls.map((call) => `${call.table}:${call.op}`)).toEqual(
      expect.arrayContaining([
        "documents:insert",
        // Dev drift: upstream #295 routes version writes through the
        // documents lifecycle facade (create_document_version RPC).
        "create_document_version:rpc",
        "documents:update",
      ]),
    );
    expect(
      calls.filter(
        (call) =>
          call.op !== "select" &&
          call.table !== "documents" &&
          call.table !== "create_document_version",
      ),
    ).toEqual([]);
  });

  it("refuses to export a run whose memo or source integrity checks failed", async () => {
    const { db, calls } = database();
    downloadFileMock.mockImplementation(async (path: string) =>
      path === "memo/path"
        ? encoder.encode("The memo was edited after verification.").buffer
        : encoder.encode(sourceText).buffer,
    );

    const result = await exportCitationReview(exportInput(), db as never);

    expect(result).toMatchObject({
      ok: false,
      error: "integrity_check_failed",
      detail: "Export blocked because memo or source integrity checks failed",
      warnings: [expect.stringContaining("memo")],
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(calls.every((call) => call.op === "select")).toBe(true);
  });

  it("reports a run in an inaccessible project exactly as a missing run", async () => {
    const { db, calls } = database({
      projectOwnerId: "someone-else",
      sharedWith: [],
    });

    const blocked = await exportCitationReview(exportInput(), db as never);

    expect(blocked).toEqual({
      ok: false,
      error: "not_found",
      detail: "Verification run not found",
    });
    // Nothing about the run may leak through the workspace read either.
    expect(calls.map((call) => call.table)).not.toContain("document_versions");
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("does not export a run belonging to another project", async () => {
    const { db, calls } = database({ runProjectId: "project-2" });

    const result = await exportCitationReview(exportInput(), db as never);

    expect(result).toMatchObject({ ok: false, error: "not_found" });
    expect(calls.map((call) => call.table)).not.toContain("projects");
  });

  it("exports for a project member the run was shared with by email", async () => {
    const { db } = database({
      projectOwnerId: "owner-1",
      sharedWith: ["User@Example.com"],
      profileEmail: "user@example.com",
    });

    const result = await exportCitationReview(exportInput(), db as never);

    expect(result).toMatchObject({ ok: true, run_id: "run-1" });
  });
});
