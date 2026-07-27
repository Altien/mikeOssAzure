import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeMcpToolCallMock,
  verifyCitationSourcesMock,
  extractDocumentForVerificationMock,
  exportCitationReviewMock,
} = vi.hoisted(() => ({
  executeMcpToolCallMock: vi.fn(),
  verifyCitationSourcesMock: vi.fn(),
  extractDocumentForVerificationMock: vi.fn(),
  exportCitationReviewMock: vi.fn(),
}));

vi.mock("./core/service", () => ({
  VerificationExtractionRequiredError: class extends Error {
    readonly code = "verification_extraction_required";

    constructor(documentId: string, versionId: string) {
      super(
        `Document ${documentId}/${versionId} must be converted with extract_document_for_verification before citation verification`,
      );
    }
  },
  registerVerificationArtifact: (
    store: Map<string, unknown>,
    artifact: { artifactId: string },
  ) => {
    store.set(artifact.artifactId, artifact);
    return artifact.artifactId;
  },
  verifyCitationSources: verifyCitationSourcesMock,
}));
vi.mock("./core/extractionService", () => ({
  extractDocumentForVerification: extractDocumentForVerificationMock,
}));
vi.mock("./core/exportService", () => ({
  exportCitationReview: exportCitationReviewMock,
}));
vi.mock("../../lib/mcpConnectors", () => ({
  executeMcpToolCall: executeMcpToolCallMock,
}));

import { VerificationExtractionRequiredError } from "./core/service";
import { runToolCalls } from "../../lib/chat/tools/toolDispatcher";
import { PROJECT_EXTRA_TOOLS } from "../../lib/chat/tools/toolSchemas";
import {
  AUTHORITY_TRACE_SYSTEM_PROMPT,
  AUTHORITY_TRACE_TOOL_NAMES,
  AUTHORITY_TRACE_TOOLS,
} from "./chatTools";

const proposal = {
  schema_version: 1,
  memo: { document_id: "doc-0" },
  sources: {
    authority: {
      document_id: "doc-1",
      title: "Authority",
      kind: "case",
    },
  },
  citations: [
    {
      id: "c001",
      source_candidates: ["authority"],
      cite_text: "Example v Example",
      proposition: "The court adopted the rule.",
      support_type: "quotation",
      anchors_proposed: [
        {
          source: "authority",
          quote: "The court adopted the rule.",
        },
      ],
    },
  ],
};

beforeEach(() => {
  executeMcpToolCallMock.mockReset();
  verifyCitationSourcesMock.mockReset();
  extractDocumentForVerificationMock.mockReset();
  exportCitationReviewMock.mockReset();
});

function exportToolCall(args: Record<string, unknown>) {
  return runToolCalls(
    [
      {
        id: "export-1",
        function: {
          name: AUTHORITY_TRACE_TOOL_NAMES.exportCitationReview,
          arguments: JSON.stringify(args),
        },
      },
    ],
    new Map(),
    "user-1",
    {} as never,
    () => {},
    undefined,
    undefined,
    { "doc-0": { document_id: "memo-id", filename: "memo.md" } },
    undefined,
    undefined,
    "project-1",
  );
}

describe("Authority Trace tool dispatch", () => {
  it("is registered as a general project tool", () => {
    expect(
      AUTHORITY_TRACE_TOOLS.map((tool) => tool.function.name),
    ).toEqual(
      expect.arrayContaining([
        AUTHORITY_TRACE_TOOL_NAMES.extractDocument,
        AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
        AUTHORITY_TRACE_TOOL_NAMES.exportCitationReview,
      ]),
    );
    expect(
      PROJECT_EXTRA_TOOLS.map((tool) => tool.function.name),
    ).toContain(AUTHORITY_TRACE_TOOL_NAMES.exportCitationReview);
    expect(JSON.stringify(AUTHORITY_TRACE_TOOLS)).not.toMatch(
      /connector|skill|diffduff|dingduff/i,
    );
  });

  it("offers the review export no parameter that could force a degraded report", () => {
    const parameters = AUTHORITY_TRACE_TOOLS.find(
      (tool) =>
        tool.function.name === AUTHORITY_TRACE_TOOL_NAMES.exportCitationReview,
    )?.function.parameters as {
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(Object.keys(parameters.properties)).toEqual(["run_id"]);
    expect(parameters.required).toEqual(["run_id"]);
    expect(parameters.additionalProperties).toBe(false);
    expect(JSON.stringify(AUTHORITY_TRACE_TOOLS)).not.toMatch(
      /force_degraded|include_originals/i,
    );
  });

  it("returns the export download reference to the model, never the report body", async () => {
    exportCitationReviewMock.mockResolvedValue({
      ok: true,
      run_id: "run-1",
      export_type: "review",
      filename: "authority-trace-run-1-review.html",
      download_url: "/download/token.signature",
      citations: { total: 1, anchored: 1, failed: 0 },
    });

    const result = await exportToolCall({ run_id: "run-1" });

    expect(exportCitationReviewMock).toHaveBeenCalledWith(
      { runId: "run-1", userId: "user-1", projectId: "project-1" },
      {},
    );
    const content = String(result.toolResults[0].content);
    expect(JSON.parse(content)).toMatchObject({
      ok: true,
      download_url: "/download/token.signature",
    });
    expect(content).not.toContain("<");
    // The export renders an existing run, so it advances no verification.
    expect(result.authorityTraceEvents).toEqual([]);
  });

  it("hands back the integrity refusal instead of an export", async () => {
    exportCitationReviewMock.mockResolvedValue({
      ok: false,
      error: "integrity_check_failed",
      detail: "Export blocked because memo or source integrity checks failed",
      warnings: ["The memo bytes no longer match this run."],
      instruction: "Do not export this run.",
    });

    const result = await exportToolCall({
      run_id: "run-1",
      force_degraded: true,
    });

    // An unschema'd argument reaches the dispatcher only if a model invents
    // it; it must never become an override.
    expect(exportCitationReviewMock).toHaveBeenCalledWith(
      { runId: "run-1", userId: "user-1", projectId: "project-1" },
      {},
    );
    expect(JSON.parse(String(result.toolResults[0].content))).toMatchObject({
      ok: false,
      error: "integrity_check_failed",
      warnings: ["The memo bytes no longer match this run."],
    });
  });

  it("extracts a project document and makes the immutable result available this turn", async () => {
    extractDocumentForVerificationMock.mockResolvedValue({
      source_document_id: "source-id",
      source_version_id: "source-v1",
      extracted_document_id: "extracted-id",
      extracted_version_id: "extracted-v1",
      filename: "source.verification.md",
      media_type: "text/markdown",
      source_media_type: "application/pdf",
      page_count: 2,
      sha256: "a".repeat(64),
      source_sha256: "b".repeat(64),
      bytes: 100,
      warnings: [],
    });
    const docIndex = {
      "doc-0": { document_id: "source-id", filename: "source.pdf" },
    };

    const result = await runToolCalls(
      [
        {
          id: "extract-1",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.extractDocument,
            arguments: JSON.stringify({
              document_id: "doc-0",
              first_page: 7,
            }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "project-1",
    );

    expect(extractDocumentForVerificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        userId: "user-1",
        documentId: "doc-0",
        firstPage: 7,
      }),
      {},
    );
    expect(docIndex).toHaveProperty("doc-1", {
      document_id: "extracted-id",
      filename: "source.verification.md",
    });
    expect(result.authorityTraceEvents).toEqual([
      expect.objectContaining({
        type: "authority_trace_extraction",
        outcome: "success",
        document_handle: "doc-1",
        document_id: "extracted-id",
        version_id: "extracted-v1",
      }),
    ]);
    expect(JSON.parse(String(result.toolResults[0].content))).toMatchObject({
      document_handle: "doc-1",
      extracted_document_id: "extracted-id",
    });
  });

  it("makes flexible LLM source discovery and deterministic verification explicit", () => {
    expect(AUTHORITY_TRACE_SYSTEM_PROMPT).toMatch(
      /whichever available.*search.*download tools/i,
    );
    expect(AUTHORITY_TRACE_SYSTEM_PROMPT).toMatch(/project document/i);
    expect(AUTHORITY_TRACE_SYSTEM_PROMPT).toMatch(/TypeScript verifier/i);
    expect(AUTHORITY_TRACE_SYSTEM_PROMPT).toMatch(
      /snippet, summary, or generated analysis.*discovery evidence only/i,
    );
    expect(AUTHORITY_TRACE_SYSTEM_PROMPT).toMatch(
      /retry actionable anchoring failures at most twice/i,
    );
    expect(AUTHORITY_TRACE_SYSTEM_PROMPT).toMatch(
      /always give the user a final synthesis/i,
    );
  });

  it("emits a safe persisted-run summary after successful verification", async () => {
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
    const writes: string[] = [];

    const result = await runToolCalls(
      [
        {
          id: "call-1",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify(proposal),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      (value) => writes.push(value),
      undefined,
      undefined,
      {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
        "doc-1": { document_id: "source-id", filename: "source.md" },
      },
      undefined,
      undefined,
      "project-1",
    );

    expect(verifyCitationSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        userId: "user-1",
        proposal,
      }),
      {},
    );
    expect(result.authorityTraceEvents).toEqual([
      {
        type: "authority_trace_verification",
        run_id: "run-1",
        outcome: "success",
        total: 1,
        anchored: 1,
        failed: 0,
        exact: 1,
        formatting_different: 0,
        no_quote_claimed: 0,
        warning_count: 0,
        diagnostics: [],
      },
    ]);
    expect(writes.join("")).toContain(
      '"type":"authority_trace_verification"',
    );
    expect(writes.join("")).not.toContain("The court adopted the rule.");
  });

  it("allows extraction and retry when verification requires a stable DOCX snapshot", async () => {
    const extractionRequired = new VerificationExtractionRequiredError(
      "memo-id",
      "memo-v1",
    );
    verifyCitationSourcesMock
      .mockRejectedValueOnce(extractionRequired)
      .mockResolvedValueOnce({
        runId: "run-after-extraction",
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
    extractDocumentForVerificationMock.mockResolvedValue({
      source_document_id: "memo-id",
      source_version_id: "memo-v1",
      extracted_document_id: "extracted-memo-id",
      extracted_version_id: "extracted-memo-v1",
      filename: "memo.verification.md",
      media_type: "text/markdown",
      source_media_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      page_count: null,
      sha256: "a".repeat(64),
      source_sha256: "b".repeat(64),
      bytes: 100,
      warnings: [],
    });
    const state = {
      verificationAttempts: 0,
      terminal: false,
      fatal: false,
    };
    const docIndex = {
      "doc-0": { document_id: "memo-id", filename: "memo.docx" },
    };
    const artifactProposal = {
      ...proposal,
      sources: {
        authority: {
          verification_source_id: "source-handle",
          title: "Authority",
          kind: "case",
        },
      },
    };

    const first = await runToolCalls(
      [
        {
          id: "verify-before-extraction",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify(artifactProposal),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      undefined,
      state,
    );

    expect(first.authorityTraceEvents).toEqual([
      expect.objectContaining({
        type: "authority_trace_verification",
        outcome: "action_required",
        error: expect.stringMatching(/extract_document_for_verification/i),
      }),
    ]);
    expect(state).toEqual({
      verificationAttempts: 0,
      terminal: false,
      fatal: false,
    });

    const extraction = await runToolCalls(
      [
        {
          id: "extract-memo",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.extractDocument,
            arguments: JSON.stringify({ document_id: "doc-0" }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      undefined,
      state,
    );
    const extractedHandle = String(
      JSON.parse(String(extraction.toolResults[0].content)).document_handle,
    );

    const second = await runToolCalls(
      [
        {
          id: "verify-after-extraction",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify({
              ...artifactProposal,
              memo: { document_id: extractedHandle },
            }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      undefined,
      state,
    );

    expect(second.authorityTraceEvents).toEqual([
      expect.objectContaining({
        type: "authority_trace_verification",
        run_id: "run-after-extraction",
        outcome: "success",
      }),
    ]);
    expect(verifyCitationSourcesMock).toHaveBeenCalledTimes(2);
  });

  it("emits a fatal event and no run id when verification rejects", async () => {
    verifyCitationSourcesMock.mockRejectedValue(new Error("Invalid proposal"));
    const state = {
      verificationAttempts: 0,
      terminal: false,
      fatal: false,
    };

    const result = await runToolCalls(
      [
        {
          id: "call-1",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify(proposal),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
        "doc-1": { document_id: "source-id", filename: "source.md" },
      },
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      undefined,
      state,
    );

    expect(result.authorityTraceEvents).toEqual([
      {
        type: "authority_trace_verification",
        outcome: "fatal",
        total: 0,
        anchored: 0,
        failed: 0,
        error: "Invalid proposal",
      },
    ]);
    expect(state.fatal).toBe(true);
    expect(result.authorityTraceEvents[0]).not.toHaveProperty("run_id");

    await runToolCalls(
      [
        {
          id: "call-2",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify(proposal),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
        "doc-1": { document_id: "source-id", filename: "source.md" },
      },
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      undefined,
      state,
    );
    expect(verifyCitationSourcesMock).toHaveBeenCalledTimes(1);
  });

  it("enforces two retries across tool batches and returns residual failures", async () => {
    let runNumber = 0;
    verifyCitationSourcesMock.mockImplementation(async () => {
      runNumber += 1;
      return {
        runId: `run-${runNumber}`,
        record: { schema_version: 1 },
        report: {
          outcome: "completed_with_failures",
          total: 1,
          anchored: 0,
          failed: 1,
          exact: 0,
          formatting_different: 0,
          no_quote_claimed: 0,
          warnings: [],
          failures: [
            {
              citation_id: "c001",
              scope: "source",
              source: "authority",
              reason: "not_found",
              hint: "Copy the passage again.",
            },
          ],
        },
      };
    });
    const state = {
      verificationAttempts: 0,
      terminal: false,
      fatal: false,
    };
    const invoke = () =>
      runToolCalls(
        [
          {
            id: `verify-${state.verificationAttempts + 1}`,
            function: {
              name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
              arguments: JSON.stringify(proposal),
            },
          },
        ],
        new Map(),
        "user-1",
        {} as never,
        () => {},
        undefined,
        undefined,
        {
          "doc-0": { document_id: "memo-id", filename: "memo.md" },
          "doc-1": { document_id: "source-id", filename: "source.md" },
        },
        undefined,
        undefined,
        "project-1",
        undefined,
        undefined,
        undefined,
        state,
      );

    const first = await invoke();
    const second = await invoke();
    const third = await invoke();
    const blocked = await invoke();

    expect(verifyCitationSourcesMock).toHaveBeenCalledTimes(3);
    expect(state.verificationAttempts).toBe(3);
    expect(JSON.parse(String(first.toolResults[0].content))).toMatchObject({
      retries_remaining: 2,
    });
    expect(JSON.parse(String(second.toolResults[0].content))).toMatchObject({
      retries_remaining: 1,
    });
    expect(JSON.parse(String(third.toolResults[0].content))).toMatchObject({
      retries_remaining: 0,
      instruction: expect.stringMatching(/residual failure/i),
    });
    expect(JSON.parse(String(blocked.toolResults[0].content))).toMatchObject({
      outcome: "retry_limit_reached",
      retries_remaining: 0,
    });
    expect(blocked.authorityTraceEvents).toEqual([]);
  });

  it("registers a read CourtListener opinion and passes it to Authority Trace", async () => {
    verifyCitationSourcesMock.mockResolvedValue({
      runId: "run-2",
      record: { schema_version: 1 },
      report: {
        outcome: "success",
        total: 1,
        anchored: 1,
        failed: 0,
        failures: [],
      },
    });
    const courtState = {
      casesByClusterId: new Map([
        [
          123,
          {
            clusterId: 123,
            caseName: "Example v Example",
            citations: ["123 U.S. 456"],
            url: "https://www.courtlistener.com/opinion/456/example/",
            pdfUrl: null,
            dateFiled: "2020-01-01",
            opinions: [
              {
                id: 456,
                text: "The court adopted the rule.",
                url: "https://www.courtlistener.com/opinion/456/example/",
              },
            ],
          },
        ],
      ]),
      verificationArtifacts: new Map(),
    };
    const artifactProposal = {
      ...proposal,
      sources: {
        authority: {
          ...proposal.sources.authority,
          document_id: "courtlistener:cluster:123:opinion:456",
        },
      },
    };

    const result = await runToolCalls(
      [
        {
          id: "read-1",
          function: {
            name: "courtlistener_read_case",
            arguments: JSON.stringify({
              clusterId: 123,
              opinionId: 456,
            }),
          },
        },
        {
          id: "verify-1",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify(artifactProposal),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
      },
      undefined,
      undefined,
      "project-1",
      courtState as never,
    );

    const readResult = result.toolResults[0] as { content: string };
    expect(JSON.parse(readResult.content).opinions[0]).toMatchObject({
      opinion_id: 456,
      verification_source_id:
        "courtlistener:cluster:123:opinion:456",
    });
    expect(verifyCitationSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceArtifacts: courtState.verificationArtifacts,
        proposal: artifactProposal,
      }),
      {},
    );
    expect(courtState.verificationArtifacts.get(
      "courtlistener:cluster:123:opinion:456",
    )).toMatchObject({
      provider: "courtlistener",
      externalId: "456",
      text: "The court adopted the rule.",
    });
  });

  it("does not promote analysis or search output into a verification source", async () => {
    executeMcpToolCallMock.mockResolvedValue({
      content: JSON.stringify({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                citation: "123 U.S. 456",
                deeplinkUrl:
                  "https://research.example.test/opinions/123",
                snippets: ["The court adopted the rule."],
              }),
            },
          ],
        },
        note: "External result.",
      }),
      event: {
        type: "mcp_tool_call",
        connector_id: "research-1",
        connector_name: "Legal research",
        tool_name: "findInOpinion",
        openai_tool_name: "mcp_research_findInOpinion",
        status: "ok",
      },
    });
    verifyCitationSourcesMock.mockResolvedValue({
      runId: "run-3",
      record: { schema_version: 1 },
      report: {
        outcome: "success",
        total: 1,
        anchored: 1,
        failed: 0,
        failures: [],
      },
    });
    const turnState = {
      casesByClusterId: new Map(),
      verificationArtifacts: new Map(),
    };

    const research = await runToolCalls(
      [
        {
          id: "research-call-1",
          function: {
            name: "mcp_research_findInOpinion",
            arguments: JSON.stringify({ citation: "123 U.S. 456" }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
      },
      undefined,
      undefined,
      "project-1",
      turnState as never,
    );

    const researchPayload = JSON.parse(
      String(research.toolResults[0].content),
    ) as Record<string, unknown>;
    expect(researchPayload).not.toHaveProperty("verification_source_id");
    expect(turnState.verificationArtifacts).toHaveLength(0);
  });

  it("reads and verifies a canonical artifact registered by any backend adapter", async () => {
    verifyCitationSourcesMock.mockResolvedValue({
      runId: "run-3",
      record: { schema_version: 1 },
      report: {
        outcome: "success",
        total: 1,
        anchored: 1,
        failed: 0,
        failures: [],
      },
    });
    const artifactId = "verification:example-research:source-1";
    const turnState = {
      casesByClusterId: new Map(),
      verificationArtifacts: new Map([
        [
          artifactId,
          {
            artifactId,
            provider: "example-research",
            externalId: "source-1",
            versionId: "source-v1",
            filename: "example-opinion.txt",
            text: "The court adopted the rule.",
            originUrl:
              "https://research.example.test/opinions/123",
          },
        ],
      ]),
    };
    const artifactProposal = {
      ...proposal,
      sources: {
        authority: {
          ...proposal.sources.authority,
          document_id: artifactId,
        },
      },
    };
    const verified = await runToolCalls(
      [
        {
          id: "read-source-1",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.readVerificationSource,
            arguments: JSON.stringify({
              verification_source_id: artifactId,
            }),
          },
        },
        {
          id: "verify-1",
          function: {
            name: AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources,
            arguments: JSON.stringify(artifactProposal),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      {
        "doc-0": { document_id: "memo-id", filename: "memo.md" },
      },
      undefined,
      undefined,
      "project-1",
      turnState as never,
    );

    const readPayload = JSON.parse(
      String(verified.toolResults[0].content),
    ) as { text: string };
    expect(readPayload.text).toContain("The court adopted the rule.");
    expect(verifyCitationSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: artifactProposal,
        sourceArtifacts: turnState.verificationArtifacts,
      }),
      {},
    );
  });
});
