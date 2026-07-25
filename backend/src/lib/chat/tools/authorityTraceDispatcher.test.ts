import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMcpToolCallMock, verifyCitationSourcesMock } = vi.hoisted(() => ({
  executeMcpToolCallMock: vi.fn(),
  verifyCitationSourcesMock: vi.fn(),
}));

vi.mock("../../citationVerification/service", () => ({
  registerVerificationArtifact: (
    store: Map<string, unknown>,
    artifact: { artifactId: string },
  ) => {
    store.set(artifact.artifactId, artifact);
    return artifact.artifactId;
  },
  verifyCitationSources: verifyCitationSourcesMock,
}));
vi.mock("../../mcpConnectors", () => ({
  executeMcpToolCall: executeMcpToolCallMock,
}));

import { runToolCalls } from "./toolDispatcher";
import {
  AUTHORITY_TRACE_SYSTEM_PROMPT,
  AUTHORITY_TRACE_TOOL_NAMES,
  AUTHORITY_TRACE_TOOLS,
} from "./authorityTraceTools";

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
});

describe("Authority Trace tool dispatch", () => {
  it("is registered as a general project tool", () => {
    expect(
      AUTHORITY_TRACE_TOOLS.map((tool) => tool.function.name),
    ).toContain(AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources);
    expect(JSON.stringify(AUTHORITY_TRACE_TOOLS)).not.toMatch(
      /connector|skill|diffduff|dingduff/i,
    );
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
      },
    ]);
    expect(writes.join("")).toContain(
      '"type":"authority_trace_verification"',
    );
    expect(writes.join("")).not.toContain("The court adopted the rule.");
  });

  it("emits a fatal event and no run id when verification rejects", async () => {
    verifyCitationSourcesMock.mockRejectedValue(new Error("Invalid proposal"));

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
