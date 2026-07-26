import { describe, expect, it } from "vitest";
import {
  firstPartyToolCatalogue,
  resolveCapabilityContract,
  resolveCapabilityContractWithLlm,
} from "./capabilities";

describe("skill capability resolution", () => {
  it("maps exact observable first-party capabilities and the read baseline", () => {
    const contract = resolveCapabilityContract({
      analysis: {
        summary: "Checks citations.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "project documents",
            kind: "project_read",
            required: true,
            rationale: "Read the memo.",
          },
          {
            name: "verify_citation_sources",
            kind: "first_party_tool",
            required: true,
            rationale: "Verify the citation.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toEqual(
      expect.arrayContaining(["read_document", "verify_citation_sources"]),
    );
    expect(contract.mappings[1].comparison).toEqual(
      expect.objectContaining({
        inputs: expect.any(Object),
        outputs: "unspecified",
        sideEffects: "external",
      }),
    );
  });

  it("grants nothing for vague language and blocks required missing tools", () => {
    const contract = resolveCapabilityContract({
      analysis: {
        summary: "Uses tools.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "appropriate tools",
            kind: "first_party_tool",
            required: false,
            rationale: "Vague.",
          },
          {
            name: "nonexistent_tool",
            kind: "first_party_tool",
            required: true,
            rationale: "Required behavior.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    });
    expect(contract.approvedToolNames).toEqual([]);
    expect(contract.mappings[0].status).toBe("vague_no_grant");
    expect(contract.blockers).toHaveLength(1);
  });

  it("does not treat an unavailable confirmation-gated MCP tool as callable", () => {
    const contract = resolveCapabilityContract({
      analysis: {
        summary: "Calls a remote service.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "mcp_remote_search",
            kind: "mcp",
            required: true,
            rationale: "Search remote data.",
          },
        ],
      },
      catalogue: [
        {
          name: "mcp_remote_search",
          source: "mcp",
          description: "Search",
          inputSchema: { type: "object" },
          sideEffects: "external",
          requiresConfirmation: true,
          available: false,
        },
      ],
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.mappings[0].status).toBe("connection_required");
  });

  it("uses the fast model to compare behavior across replacement tools", async () => {
    const contract = await resolveCapabilityContractWithLlm({
      analysis: {
        summary: "Reads a trusted source.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "case_source_reader",
            kind: "first_party_tool",
            required: true,
            rationale: "Read the exact verification source.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: async () =>
        JSON.stringify({
          assessments: [
            {
              requirementName: "case_source_reader",
              compatible: true,
              toolName: "read_verification_source",
              reason: "It returns the exact bounded source text.",
              comparison: {
                purpose: "read source",
                inputs: "source id",
                outputs: "source text",
                errorsLimits: "bounded",
                dataAccess: "trusted source cache",
                sideEffects: "read",
              },
            },
          ],
        }),
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toContain("read_verification_source");
    expect(contract.mappings[0]).toMatchObject({
      status: "llm_compatible",
      mappedSource: "first_party",
    });
    expect(contract.compatibilityAssessment).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-lite",
    });
  });

  it("requires named skills to be exact approved version dependencies", async () => {
    let modelCalled = false;
    const base = {
      analysis: {
        summary: "Uses another skill.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "Citation Reader",
            kind: "skill" as const,
            required: true,
            rationale: "Read cited material.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: async () => {
        modelCalled = true;
        return '{"assessments":[]}';
      },
    };
    const missing = await resolveCapabilityContractWithLlm(base);
    expect(missing.blockers).toHaveLength(1);
    expect(missing.mappings[0].status).toBe("dependency_required");
    expect(modelCalled).toBe(false);

    const bound = await resolveCapabilityContractWithLlm({
      ...base,
      skillDependencies: [
        {
          canonicalName: "citation-reader",
          displayName: "Citation Reader",
          versionId: "version-7",
          contentHash: "hash-7",
        },
      ],
    });
    expect(bound.blockers).toEqual([]);
    expect(bound.mappings[0]).toMatchObject({
      status: "dependency_compatible",
      comparison: { versionId: "version-7", contentHash: "hash-7" },
    });
    expect(bound.approvedToolNames).toEqual([]);
  });
});
