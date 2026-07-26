import { describe, expect, it } from "vitest";
import {
  applyCapabilityAmendments,
  firstPartyToolCatalogue,
  resolveCapabilityContract,
  resolveCapabilityContractWithLlm,
} from "./capabilities";

describe("skill capability resolution", () => {
  it("grants the read baseline but only proposes exact name matches", () => {
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
    expect(contract.approvedToolNames).toEqual(
      expect.arrayContaining(["read_document"]),
    );
    // Name equality is not behavioural evidence: nothing is granted for it.
    expect(contract.approvedToolNames).not.toContain("verify_citation_sources");
    expect(contract.mappings[0].status).toBe("compatible");
    expect(contract.mappings[1]).toMatchObject({
      status: "proposed",
      mappedToolNames: ["verify_citation_sources"],
    });
    expect(contract.mappings[1].comparison).toEqual(
      expect.objectContaining({
        inputs: expect.any(Object),
        outputs: "unspecified",
        sideEffects: "external",
        matchBasis: expect.stringContaining("name equality"),
      }),
    );
    // A required, still-unapproved proposal blocks deterministic enablement.
    expect(contract.blockers).toHaveLength(1);
    expect(contract.blockers[0].requirement.name).toBe(
      "verify_citation_sources",
    );
  });

  it("puts exact name matches through the same behavioural approval as fuzzy matches", async () => {
    let sentRequirements: unknown;
    const contract = await resolveCapabilityContractWithLlm({
      analysis: {
        summary: "Checks citations.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "verify_citation_sources",
            kind: "first_party_tool",
            required: true,
            rationale: "Verify the citation.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: async ({ user }) => {
        sentRequirements = (JSON.parse(user) as { requirements: unknown })
          .requirements;
        return JSON.stringify({
          assessments: [
            {
              requirementName: "verify_citation_sources",
              compatible: true,
              toolName: "verify_citation_sources",
              reason: "Purpose, inputs, outputs and side effects match.",
              comparison: {
                purpose: "verify citations",
                inputs: "citation text",
                outputs: "verification result",
                errorsLimits: "bounded",
                dataAccess: "trusted source cache",
                sideEffects: "external",
              },
            },
          ],
        });
      },
    });
    // The exact-name candidate is offered to the comparison, ranked first.
    expect(sentRequirements).toEqual([
      expect.objectContaining({
        name: "verify_citation_sources",
        proposedCandidateNames: ["verify_citation_sources"],
      }),
    ]);
    expect(contract.mappings[0]).toMatchObject({
      status: "llm_compatible",
      mappedSource: "first_party",
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toEqual(["verify_citation_sources"]);
  });

  it("keeps a rejected exact name match unapproved and blocking", async () => {
    const contract = await resolveCapabilityContractWithLlm({
      analysis: {
        summary: "Checks citations.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "verify_citation_sources",
            kind: "first_party_tool",
            required: true,
            rationale: "Verify against an external registry.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: async () =>
        JSON.stringify({
          assessments: [
            {
              requirementName: "verify_citation_sources",
              compatible: false,
              toolName: null,
              reason: "Same name, different observable behaviour.",
              comparison: { purpose: "not comparable" },
            },
          ],
        }),
    });
    expect(contract.mappings[0]).toMatchObject({
      status: "incompatible",
      mappedToolNames: [],
    });
    expect(contract.approvedToolNames).toEqual([]);
    expect(contract.blockers).toHaveLength(1);
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
    expect(contract.mappings[0].status).toBe("needs_admin_selection");
    expect(contract.blockers).toHaveLength(1);
    expect(contract.blockers[0].requirement.name).toBe("nonexistent_tool");
  });

  it("offers a required vague requirement for explicit admin selection instead of blocking", () => {
    const contract = resolveCapabilityContract({
      analysis: {
        summary: "Uses tools.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "appropriate tools",
            kind: "first_party_tool",
            required: true,
            rationale: "Whatever tools are needed.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toEqual([]);
    expect(contract.mappings[0]).toMatchObject({
      status: "needs_admin_selection",
      mappedToolNames: [],
      comparison: {
        requestedCapabilityText: "appropriate tools",
        rationale: "Whatever tools are needed.",
      },
    });
  });

  it("never sends a vague requirement to the fast model and still grants nothing", async () => {
    let modelCalled = false;
    const contract = await resolveCapabilityContractWithLlm({
      analysis: {
        summary: "Uses tools.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "tools",
            kind: "first_party_tool",
            required: true,
            rationale: "Unspecified.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: async () => {
        modelCalled = true;
        return '{"assessments":[]}';
      },
    });
    expect(modelCalled).toBe(false);
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toEqual([]);
    expect(contract.mappings[0].status).toBe("needs_admin_selection");
  });

  it("does not treat an unavailable confirmation-gated MCP tool as callable", async () => {
    const base = {
      analysis: {
        summary: "Calls a remote service.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "mcp_remote_search",
            kind: "mcp" as const,
            required: true,
            rationale: "Search remote data.",
          },
        ],
      },
      catalogue: [
        {
          name: "mcp_remote_search",
          source: "mcp" as const,
          description: "Search",
          inputSchema: { type: "object" },
          sideEffects: "external" as const,
          requiresConfirmation: true,
          available: false,
        },
      ],
    };
    const deterministic = resolveCapabilityContract(base);
    expect(deterministic.mappings[0]).toMatchObject({
      status: "proposed",
      comparison: { currentlyAvailable: false },
    });
    expect(deterministic.approvedToolNames).toEqual([]);

    const assessed = await resolveCapabilityContractWithLlm({
      ...base,
      model: "gpt-5.4-lite",
      complete: async () =>
        JSON.stringify({
          assessments: [
            {
              requirementName: "mcp_remote_search",
              compatible: true,
              toolName: "mcp_remote_search",
              reason: "Same observable search contract.",
              comparison: { purpose: "search" },
            },
          ],
        }),
    });
    expect(assessed.blockers).toEqual([]);
    expect(assessed.mappings[0].status).toBe("connection_required");
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

describe("applyCapabilityAmendments", () => {
  const reviewed = () =>
    resolveCapabilityContract({
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
            name: "appropriate tools",
            kind: "first_party_tool",
            required: false,
            rationale: "The skill names its tools vaguely.",
          },
          {
            name: "generate_docx",
            kind: "first_party_tool",
            required: false,
            rationale: "Writes a brief.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    }) as unknown as Record<string, unknown>;

  it("grants an explicit minimum capability set for a vague requirement", () => {
    const amended = applyCapabilityAmendments({
      contract: reviewed(),
      amendments: [
        {
          kind: "select_capability",
          requirementName: "appropriate tools",
          toolNames: ["generate_docx"],
        },
      ],
      catalogue: firstPartyToolCatalogue(),
    });
    expect(amended.contract.approvedToolNames).toContain("generate_docx");
    expect(
      (amended.contract.mappings as Array<Record<string, unknown>>)[1],
    ).toMatchObject({
      status: "admin_selected",
      mappedToolNames: ["generate_docx"],
    });
    expect(amended.effects[0]).toContain("appropriate tools");
  });

  it("drops a name-match candidate the administrator refuses", () => {
    const amended = applyCapabilityAmendments({
      contract: reviewed(),
      amendments: [
        { kind: "reject_capability", requirementName: "generate_docx" },
      ],
      catalogue: firstPartyToolCatalogue(),
    });
    expect(amended.contract.approvedToolNames).not.toContain("generate_docx");
    expect(
      (amended.contract.mappings as Array<Record<string, unknown>>)[2],
    ).toMatchObject({ status: "admin_rejected", mappedToolNames: [] });
  });

  it("only ever narrows the approved tool set", () => {
    const amended = applyCapabilityAmendments({
      contract: reviewed(),
      amendments: [{ kind: "restrict_tools", toolNames: ["read_document"] }],
      catalogue: firstPartyToolCatalogue(),
    });
    expect(amended.contract.approvedToolNames).toEqual(["read_document"]);

    expect(() =>
      applyCapabilityAmendments({
        contract: reviewed(),
        amendments: [{ kind: "restrict_tools", toolNames: ["generate_docx"] }],
        catalogue: firstPartyToolCatalogue(),
      }),
    ).toThrow("was not in the reviewed approved set");
  });

  it("refuses a selection outside the catalogue or already resolved", () => {
    expect(() =>
      applyCapabilityAmendments({
        contract: reviewed(),
        amendments: [
          {
            kind: "select_capability",
            requirementName: "appropriate tools",
            toolNames: ["exfiltrate_documents"],
          },
        ],
        catalogue: firstPartyToolCatalogue(),
      }),
    ).toThrow("is not in the tool catalogue");

    expect(() =>
      applyCapabilityAmendments({
        contract: reviewed(),
        amendments: [
          {
            kind: "select_capability",
            requirementName: "project documents",
            toolNames: ["generate_docx"],
          },
        ],
        catalogue: firstPartyToolCatalogue(),
      }),
    ).toThrow("cannot be amended");
  });
});
