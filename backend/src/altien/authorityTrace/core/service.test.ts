import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));

vi.mock("../../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import { verifyCitationSources } from "./service";

function arrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function proposal() {
  return {
    schema_version: 1 as const,
    memo: { document_id: "doc-0" },
    sources: {
      authority: {
        document_id: "doc-1",
        title: "Authority",
        kind: "case" as const,
      },
    },
    citations: [
      {
        id: "c001",
        source_candidates: ["authority"],
        cite_text: "Example v Example",
        proposition: "The court adopted the rule.",
        support_type: "quotation" as const,
        anchors_proposed: [
          {
            source: "authority",
            quote: "The court adopted the rule.",
          },
        ],
      },
    ],
  };
}

function database(overrides?: {
  sourceProjectId?: string;
  insertError?: string;
  memoFileType?: string;
}) {
  const respond = (call: DbCall) => {
    if (call.table === "documents") {
      return {
        data: [
          {
            id: "memo-id",
            project_id: "project-1",
            current_version_id: "memo-v1",
            status: "ready",
          },
          {
            id: "source-id",
            project_id: overrides?.sourceProjectId ?? "project-1",
            current_version_id: "source-v1",
            status: "ready",
          },
        ],
      };
    }
    if (call.table === "document_versions") {
      return {
        data: [
          {
            id: "memo-v1",
            document_id: "memo-id",
            storage_path: "memo/path",
            filename: "memo.md",
            file_type: overrides?.memoFileType ?? "md",
          },
          {
            id: "source-v1",
            document_id: "source-id",
            storage_path: "source/path",
            filename: "authority.md",
            file_type: "md",
          },
        ],
      };
    }
    if (call.table === "citation_verification_runs") {
      return overrides?.insertError
        ? { data: null, error: { message: overrides.insertError } }
        : { data: [{ id: "run-1" }] };
    }
    return { data: [] };
  };
  return makeFakeDb(respond);
}

beforeEach(() => {
  downloadFileMock.mockReset();
  downloadFileMock.mockImplementation(async (path: string) =>
    path === "memo/path"
      ? arrayBuffer("Example v Example confirms this.")
      : arrayBuffer("The court adopted the rule."),
  );
});

describe("verifyCitationSources", () => {
  it("snapshots both active versions before reading storage and persists last", async () => {
    const { db, calls } = database();
    const result = await verifyCitationSources(
      {
        projectId: "project-1",
        userId: "user-1",
        proposal: proposal(),
        docIndex: {
          "doc-0": { document_id: "memo-id", filename: "memo.md" },
          "doc-1": { document_id: "source-id", filename: "authority.md" },
        },
      },
      db as never,
    );

    expect(result.runId).toBe("run-1");
    expect(result.report.outcome).toBe("success");
    expect(calls.map((call) => `${call.table}:${call.op}`)).toEqual([
      "documents:select",
      "document_versions:select",
      "citation_verification_runs:insert",
    ]);
    expect(downloadFileMock.mock.calls.map(([path]) => path)).toEqual([
      "memo/path",
      "source/path",
    ]);
  });

  it("fails before storage reads or persistence when a source is outside the project", async () => {
    const { db, callsFor } = database({ sourceProjectId: "project-2" });

    await expect(
      verifyCitationSources(
        {
          projectId: "project-1",
          userId: "user-1",
          proposal: proposal(),
          docIndex: {
            "doc-0": { document_id: "memo-id", filename: "memo.md" },
            "doc-1": { document_id: "source-id", filename: "authority.md" },
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/not accessible/i);

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(callsFor("citation_verification_runs", "insert")).toHaveLength(0);
  });

  it("verifies a trusted backend artifact without downloading it again", async () => {
    const input = proposal();
    input.sources.authority.document_id =
      "courtlistener:cluster:123:opinion:456";
    const { db, calls } = database();

    const result = await verifyCitationSources(
      {
        projectId: "project-1",
        userId: "user-1",
        proposal: input,
        docIndex: {
          "doc-0": { document_id: "memo-id", filename: "memo.md" },
        },
        sourceArtifacts: new Map([
          [
            "courtlistener:cluster:123:opinion:456",
            {
              artifactId: "courtlistener:cluster:123:opinion:456",
              provider: "courtlistener",
              externalId: "456",
              versionId: "opinion-456",
              filename: "Example v Example-opinion-456.txt",
              text: "The court adopted the rule.",
              originUrl:
                "https://www.courtlistener.com/opinion/456/example/",
            },
          ],
        ]),
      },
      db as never,
    );

    expect(result.report.outcome).toBe("success");
    expect(result.record.sources.authority).toMatchObject({
      document_id: "courtlistener:cluster:123:opinion:456",
      version_id: "opinion-456",
      provider: "courtlistener",
      origin_url: "https://www.courtlistener.com/opinion/456/example/",
    });
    expect(downloadFileMock.mock.calls.map(([path]) => path)).toEqual([
      "memo/path",
    ]);
    expect(calls.map((call) => `${call.table}:${call.op}`)).toEqual([
      "documents:select",
      "document_versions:select",
      "citation_verification_runs:insert",
    ]);
    expect(
      calls.find(
        (call) => call.table === "citation_verification_runs",
      )?.payload,
    ).not.toHaveProperty("source_snapshots");
  });

  it("requires DOCX and PDF inputs to use the stable extraction tool", async () => {
    const { db, callsFor } = database({ memoFileType: "pdf" });

    await expect(
      verifyCitationSources(
        {
          projectId: "project-1",
          userId: "user-1",
          proposal: proposal(),
          docIndex: {
            "doc-0": { document_id: "memo-id", filename: "memo.pdf" },
            "doc-1": { document_id: "source-id", filename: "authority.md" },
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/extract_document_for_verification/i);

    expect(callsFor("citation_verification_runs", "insert")).toHaveLength(0);
  });

  it("fails explicitly when a requested artifact version does not match turn state", async () => {
    const input = proposal();
    input.sources.authority.document_id =
      "verification:tool-result:source-1";
    input.sources.authority.version_id = "sha256-stale";
    const { db, callsFor } = database();

    await expect(
      verifyCitationSources(
        {
          projectId: "project-1",
          userId: "user-1",
          proposal: input,
          docIndex: {
            "doc-0": { document_id: "memo-id", filename: "memo.md" },
          },
          sourceArtifacts: new Map([
            [
              "verification:tool-result:source-1",
              {
                artifactId: "verification:tool-result:source-1",
                provider: "tool:Legal research",
                externalId: "call-1",
                versionId: "sha256-current",
                filename: "find-result.txt",
                text: "The court adopted the rule.",
              },
            ],
          ]),
        },
        db as never,
      ),
    ).rejects.toThrow(/source version mismatch/i);

    expect(callsFor("citation_verification_runs", "insert")).toHaveLength(0);
  });

  it("does not report a run when persistence fails", async () => {
    const { db } = database({ insertError: "database unavailable" });

    await expect(
      verifyCitationSources(
        {
          projectId: "project-1",
          userId: "user-1",
          proposal: proposal(),
          docIndex: {
            "doc-0": { document_id: "memo-id", filename: "memo.md" },
            "doc-1": { document_id: "source-id", filename: "authority.md" },
          },
        },
        db as never,
      ),
    ).rejects.toThrow(/database unavailable/i);
  });
});
