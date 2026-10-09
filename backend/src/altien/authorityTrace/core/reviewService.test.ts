import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../../test/helpers/fakeDb";
import { verificationProposalSchema } from "./schemas";
import { verifyResolvedProposal } from "./verify";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));
vi.mock("../../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import {
  createCitationVerificationReview,
  getAuthorityTraceWorkspace,
} from "./reviewService";

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
  reviews?: unknown[];
  externalSource?: boolean;
  missingSourceVersion?: boolean;
  projectRunIds?: string[];
}) {
  const result = verified();
  const respond = (call: DbCall) => {
    if (call.table === "citation_verification_runs") {
      if (call.columns === "verified_record") {
        return { data: [{ verified_record: result.record }] };
      }
      if (call.columns === "id") {
        return {
          data: (options?.projectRunIds ?? ["run-1"]).map((id) => ({ id })),
        };
      }
      return {
        data: [
          {
            id: "run-1",
            project_id: "project-1",
            verified_record: result.record,
            report: result.report,
            created_at: "2026-07-25T12:00:00.000Z",
          },
        ],
      };
    }
    if (call.table === "documents") {
      return {
        data: [{ id: "memo-id" }, { id: "source-id" }],
      };
    }
    if (call.table === "document_versions") {
      const requestedIds = call.filters.find(
        ([method, column]) => method === "in" && column === "id",
      )?.[2];
      if (
        Array.isArray(requestedIds) &&
        requestedIds.includes("external-dms-v1")
      ) {
        return {
          data: [
            {
              id: "external-dms-v1",
              document_id: "external-dms-id",
              storage_path: "external/path",
              filename: "authority.txt",
            },
          ],
        };
      }
      return {
        data: [
          {
            id: "memo-v1",
            document_id: "memo-id",
            storage_path: "memo/path",
            filename: "memo.md",
          },
          ...(options?.externalSource || options?.missingSourceVersion
            ? []
            : [
                {
                  id: "source-v1",
                  document_id: "source-id",
                  storage_path: "source/path",
                  filename: "authority.md",
                },
              ]),
        ],
      };
    }
    if (call.table === "external_source_cache") {
      return {
        data: options?.externalSource
          ? [
              {
                id: "source-id",
                project_id: "project-1",
                version_id: "source-v1",
                title: "Authority",
                content_hash: result.record.sources.authority.sha256,
                content_bytes: result.record.sources.authority.bytes,
                document_id: "external-dms-id",
                document_version_id: "external-dms-v1",
              },
            ]
          : [],
      };
    }
    if (
      call.table === "citation_verification_reviews" &&
      call.op === "select"
    ) {
      return { data: options?.reviews ?? [] };
    }
    if (
      call.table === "citation_verification_reviews" &&
      call.op === "insert"
    ) {
      return {
        data: [
          {
            id: "review-new",
            ...(call.payload as object),
            created_at: "2026-07-25T13:00:00.000Z",
          },
        ],
      };
    }
    return { data: [] };
  };
  return { ...makeFakeDb(respond), result };
}

beforeEach(() => {
  downloadFileMock
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "memo/path"
        ? encoder.encode(memoText).buffer
        : encoder.encode(sourceText).buffer,
    );
});

describe("getAuthorityTraceWorkspace", () => {
  it("returns complete server-segmented memo/source text and current reviews", async () => {
    const binding = verified().record.citations[0].binds_to;
    const reviewDb = database({
      reviews: [
        {
          id: "review-stale",
          run_id: "run-1",
          citation_id: "c001",
          binds_to: "f".repeat(64),
          verdict: "rejected",
          note: null,
          reviewer_user_id: "user-2",
          reviewer_email: "other@example.com",
          created_at: "2026-07-25T11:00:00.000Z",
        },
        {
          id: "review-current",
          run_id: "run-1",
          citation_id: "c001",
          binds_to: binding,
          verdict: "verified",
          note: "Checked",
          reviewer_user_id: "user-1",
          reviewer_email: "user@example.com",
          created_at: "2026-07-25T12:00:00.000Z",
        },
      ],
    });

    const workspace = await getAuthorityTraceWorkspace(
      "run-1",
      reviewDb.db as never,
    );

    expect(
      workspace?.memo.segments.map((segment) => segment.text).join(""),
    ).toBe(memoText);
    expect(
      workspace?.sources.authority.segments
        .map((segment) => segment.text)
        .join(""),
    ).toBe(sourceText);
    expect(workspace?.current_reviews.c001).toMatchObject({
      id: "review-current",
      verdict: "verified",
      stale: false,
    });
    expect(
      workspace?.reviews.find((review) => review.id === "review-stale"),
    ).toMatchObject({ stale: true });
    expect(reviewDb.result.record.citations[0].status).toBe("anchored");
    expect(workspace?.integrity).toEqual({ ok: true, warnings: [] });
  });

  it("loads an external source from the durable scoped cache", async () => {
    const { db, callsFor } = database({ externalSource: true });

    const workspace = await getAuthorityTraceWorkspace("run-1", db as never);

    expect(
      workspace?.sources.authority.segments
        .map((segment) => segment.text)
        .join(""),
    ).toBe(sourceText);
    expect(callsFor("external_source_cache", "select")).toHaveLength(1);
  });

  it("suppresses highlights and reports source drift", async () => {
    downloadFileMock.mockImplementation(
      async (path: string) =>
        encoder.encode(
          path === "memo/path" ? memoText : `${sourceText} changed`,
        ).buffer,
    );
    const { db } = database();

    const workspace = await getAuthorityTraceWorkspace("run-1", db as never);

    expect(workspace?.sources.authority.integrity).toBe("changed");
    expect(
      workspace?.sources.authority.segments.flatMap(
        (segment) => segment.highlights,
      ),
    ).toEqual([]);
    expect(workspace?.integrity.warnings[0]).toMatchObject({
      scope: "source",
      source: "authority",
      status: "changed",
    });
  });

  it("represents a missing source without loading an unscoped cache row", async () => {
    const { db, callsFor } = database({ missingSourceVersion: true });

    const workspace = await getAuthorityTraceWorkspace("run-1", db as never);

    expect(workspace?.sources.authority).toMatchObject({
      available: false,
      integrity: "missing",
      segments: [{ text: "", highlights: [] }],
    });
    expect(
      callsFor("external_source_cache", "select")[0]?.filters,
    ).toContainEqual(["eq", "project_id", "project-1"]);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the latest matching verdict across reruns deterministically", async () => {
    const binding = verified().record.citations[0].binds_to;
    const { db } = database({
      projectRunIds: ["run-old", "run-1"],
      reviews: [
        {
          id: "review-a",
          run_id: "run-old",
          citation_id: "c009",
          binds_to: binding,
          verdict: "verified",
          note: "first",
          reviewer_user_id: "user-1",
          reviewer_email: null,
          created_at: "2026-07-25T11:00:00.000Z",
        },
        {
          id: "review-b",
          run_id: "run-1",
          citation_id: "c001",
          binds_to: binding,
          verdict: "needs_attention",
          note: "concurrent winner",
          reviewer_user_id: "user-2",
          reviewer_email: null,
          created_at: "2026-07-25T11:00:00.000Z",
        },
      ],
    });

    const workspace = await getAuthorityTraceWorkspace("run-1", db as never);

    expect(workspace?.reviews).toHaveLength(2);
    expect(workspace?.current_reviews.c001).toMatchObject({
      id: "review-b",
      verdict: "needs_attention",
      stale: false,
    });
  });
});

describe("createCitationVerificationReview", () => {
  it("appends a verdict with authenticated reviewer identity", async () => {
    const { db, callsFor, result } = database();
    const review = await createCitationVerificationReview(
      {
        runId: "run-1",
        body: {
          citation_id: "c001",
          binds_to: result.record.citations[0].binds_to,
          verdict: "needs_attention",
          note: "Check treatment",
        },
        reviewerUserId: "user-1",
        reviewerEmail: "user@example.com",
      },
      db as never,
    );

    expect(review).toMatchObject({
      id: "review-new",
      verdict: "needs_attention",
      reviewer_user_id: "user-1",
      reviewer_email: "user@example.com",
      stale: false,
    });
    expect(callsFor("citation_verification_reviews", "insert")).toHaveLength(1);
  });

  it("rejects a stale binding without writing a review", async () => {
    const { db, callsFor } = database();
    await expect(
      createCitationVerificationReview(
        {
          runId: "run-1",
          body: {
            citation_id: "c001",
            binds_to: "f".repeat(64),
            verdict: "verified",
          },
          reviewerUserId: "user-1",
        },
        db as never,
      ),
    ).rejects.toThrow(/content changed/i);
    expect(callsFor("citation_verification_reviews", "insert")).toHaveLength(0);
  });
});
