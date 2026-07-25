import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  streamChatWithToolsMock,
  verifyCitationSourcesMock,
  extractDocumentForVerificationMock,
} = vi.hoisted(() => ({
  streamChatWithToolsMock: vi.fn(),
  verifyCitationSourcesMock: vi.fn(),
  extractDocumentForVerificationMock: vi.fn(),
}));

vi.mock("../llm", () => ({
  DEFAULT_MAIN_MODEL: "test-model",
  resolveModel: (model?: string) => model ?? "test-model",
  streamChatWithTools: streamChatWithToolsMock,
}));
vi.mock("../mcpConnectors", () => ({
  buildUserMcpTools: vi.fn().mockResolvedValue([]),
  executeMcpToolCall: vi.fn(),
}));
vi.mock("../citationVerification/service", () => ({
  registerVerificationArtifact: (
    store: Map<string, unknown>,
    artifact: { artifactId: string },
  ) => {
    store.set(artifact.artifactId, artifact);
    return artifact.artifactId;
  },
  verifyCitationSources: verifyCitationSourcesMock,
}));
vi.mock("../citationVerification/extractionService", () => ({
  extractDocumentForVerification: extractDocumentForVerificationMock,
}));

import { runLLMStream } from "./streaming";
import { AUTHORITY_TRACE_TOOL_NAMES } from "./tools/authorityTraceTools";
import { PROJECT_EXTRA_TOOLS } from "./tools/toolSchemas";

beforeEach(() => {
  streamChatWithToolsMock.mockReset();
  verifyCitationSourcesMock.mockReset();
  extractDocumentForVerificationMock.mockReset();
});

describe("project-chat Authority Trace orchestration", () => {
  it("runs extract, propose, verify, persists a run, and synthesizes the result", async () => {
    extractDocumentForVerificationMock.mockResolvedValue({
      source_document_id: "source-id",
      source_version_id: "source-v1",
      extracted_document_id: "extracted-id",
      extracted_version_id: "extracted-v1",
      filename: "authority.verification.md",
      media_type: "text/markdown",
      source_media_type: "application/pdf",
      page_count: 1,
      sha256: "a".repeat(64),
      source_sha256: "b".repeat(64),
      bytes: 100,
      warnings: [],
    });
    verifyCitationSourcesMock.mockResolvedValue({
      runId: "run-1",
      record: { schema_version: 1 },
      report: {
        outcome: "success",
        total: 1,
        anchored: 1,
        failed: 0,
        exact: 1,
        formatting_different: 0,
        no_quote_claimed: 0,
        warnings: [],
        failures: [],
      },
    });
    streamChatWithToolsMock.mockImplementation(
      async (params: {
        tools: Array<{ function: { name: string } }>;
        callbacks: { onContentDelta?: (text: string) => void };
        runTools: (calls: Array<{
          id: string;
          name: string;
          input: Record<string, unknown>;
        }>) => Promise<Array<{ tool_use_id: string; content: string }>>;
      }) => {
        expect(params.tools.map((tool) => tool.function.name)).toEqual(
          expect.arrayContaining([
            AUTHORITY_TRACE_TOOL_NAMES.extractDocument,
            AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
          ]),
        );
        const extracted = await params.runTools([
          {
            id: "extract-1",
            name: AUTHORITY_TRACE_TOOL_NAMES.extractDocument,
            input: { document_id: "doc-1" },
          },
        ]);
        const extractionResult = JSON.parse(extracted[0].content) as {
          document_handle: string;
        };
        expect(extractionResult.document_handle).toBe("doc-2");

        await params.runTools([
          {
            id: "verify-1",
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            input: {
              schema_version: 1,
              memo: { document_id: "doc-0" },
              sources: {
                authority: {
                  document_id: extractionResult.document_handle,
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
                    {
                      source: "authority",
                      quote: "The rule applies.",
                    },
                  ],
                },
              ],
            },
          },
        ]);
        params.callbacks.onContentDelta?.(
          "Authority Trace anchored 1 citation exactly.",
        );
        return {
          fullText: "Authority Trace anchored 1 citation exactly.",
        };
      },
    );
    const writes: string[] = [];

    const result = await runLLMStream({
      apiMessages: [
        { role: "system", content: "System" },
        { role: "user", content: "Verify the citation" },
      ],
      docStore: new Map(),
      docIndex: {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
        "doc-1": { document_id: "source-id", filename: "authority.pdf" },
      },
      userId: "user-1",
      db: {} as never,
      write: (value) => writes.push(value),
      projectId: "project-1",
      includeResearchTools: false,
      extraTools: PROJECT_EXTRA_TOOLS,
    });

    expect(verifyCitationSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        proposal: expect.objectContaining({
          sources: {
            authority: expect.objectContaining({
              document_id: "doc-2",
            }),
          },
        }),
        docIndex: expect.objectContaining({
          "doc-2": {
            document_id: "extracted-id",
            filename: "authority.verification.md",
          },
        }),
      }),
      {},
    );
    expect(result.fullText).toContain("anchored 1 citation exactly");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "authority_trace_extraction",
          outcome: "success",
        }),
        expect.objectContaining({
          type: "authority_trace_verification",
          run_id: "run-1",
          outcome: "success",
        }),
      ]),
    );
    expect(writes.join("")).toContain('"run_id":"run-1"');
  });
});
