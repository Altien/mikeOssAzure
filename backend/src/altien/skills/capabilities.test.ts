import { describe, expect, it } from "vitest";
import {
  applyCapabilityAmendments,
  firstPartyToolCatalogue,
  resolveCapabilityContract,
  resolveCapabilityContractWithLlm,
  UNAPPROVED_STATUSES,
  toolDisplayLabels,
  labelForTool,
} from "./capabilities";

describe("bundled executables versus a missing connector", () => {
  // The three requirements a real kimi-k3 analysis produced for DingDuff's
  // citation-check skill.
  const contract = () =>
    resolveCapabilityContract({
      analysis: {
        summary: "Verifies citations in a drafted memo.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "Local shell with python3 and script execution",
            kind: "first_party_tool",
            required: true,
            rationale: "Runs the bundled verification scripts.",
          },
          {
            name: "citecheck_review MCP tool",
            kind: "mcp",
            required: true,
            rationale: "Opens the interactive review panel.",
          },
          {
            name: "opinion_store / statute_store (DingDuff fetch tools)",
            kind: "mcp",
            required: true,
            rationale: "Fetches the cited sources.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    });

  it("maps a bundled script onto an existing tool rather than refusing it", () => {
    // Wanting to run bundled code is only unsatisfiable once nothing here
    // does the same job. A script named after a real tool must still map.
    const mapped = resolveCapabilityContract({
      analysis: {
        summary: "Reads documents with a bundled script.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "read_document",
            kind: "first_party_tool",
            required: true,
            rationale: "The bundled python script extracts document text.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    }).mappings[0];
    expect(mapped.status).toBe("proposed");
    expect(mapped.mappedToolNames).toEqual(["read_document"]);
  });

  it("offers an unmatched script to the behavioural comparison", () => {
    // It must reach the LLM pass, which is where a differently-named Mike
    // tool can still be recognised as doing the same job.
    const shell = contract().mappings.find((mapping) =>
      mapping.requirement.name.startsWith("Local shell"),
    );
    expect(UNAPPROVED_STATUSES).toContain(shell?.status);
  });

  it("never blocks on code Mike will not execute", () => {
    const shell = contract().mappings.find((mapping) =>
      mapping.requirement.name.startsWith("Local shell"),
    );
    expect(shell?.status).toBe("not_executed");
    expect(shell?.mappedToolNames).toEqual([]);
    expect(
      contract().blockers.map((blocker) => blocker.requirement.name),
    ).not.toContain("Local shell with python3 and script execution");
  });

  it("still blocks on a connector the administrator could add", () => {
    const blocked = contract().blockers.map((b) => b.requirement.name);
    expect(blocked).toContain("citecheck_review MCP tool");
    expect(blocked).toContain(
      "opinion_store / statute_store (DingDuff fetch tools)",
    );
  });
});

describe("skill package resource baseline", () => {
  it("is in the catalogue so a reviewer can see what the runtime grants", () => {
    const names = firstPartyToolCatalogue().map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_skill_resources",
        "read_skill_resource",
        "search_skill_resources",
      ]),
    );
  });

  it("resolves package reading whatever kind the model labelled it", () => {
    // Verbatim from a real kimi-k3 analysis: it labelled reading the skill's
    // own package `kind: "skill"`, as though the package were a separate
    // skill to bind. That mislabel used to make the version unenablable.
    const contract = resolveCapabilityContract({
      analysis: {
        summary: "Summarises a litigation document.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "project document reading (list_documents / read_document / fetch_documents / find_in_document)",
            kind: "project_read",
            required: true,
            rationale: "Step 1 requires reading the project documents.",
          },
          {
            name: "skill resource loading tools for reference/house-format.md",
            kind: "skill",
            required: true,
            rationale:
              "Step 2 mandates loading 'reference/house-format.md' with 'the skill resource tools'.",
          },
          {
            name: "general language model summarisation",
            kind: "model",
            required: true,
            rationale: "Producing structured issues requires reasoning.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toEqual(
      expect.arrayContaining(["read_skill_resource"]),
    );
  });

  it("never blocks a skill that asks to read its own package", () => {
    const contract = resolveCapabilityContract({
      analysis: {
        summary: "Follows a house format shipped in the package.",
        risks: [],
        unresolvedReferences: [],
        capabilityRequirements: [
          {
            name: "read_skill_resource",
            kind: "first_party_tool",
            required: true,
            rationale: "Loads reference/house-format.md.",
          },
          {
            // Prose from a model that was never shown the schemas — this is
            // the phrasing that used to read as a missing capability.
            name: "skill resource loading tools for reference/house-format.md",
            kind: "first_party_tool",
            required: true,
            rationale: "Loads the house format before writing.",
          },
        ],
      },
      catalogue: firstPartyToolCatalogue(),
    });
    expect(contract.blockers).toEqual([]);
    for (const mapping of contract.mappings) {
      expect(mapping.status).toBe("compatible");
    }
    expect(contract.approvedToolNames).toEqual(
      expect.arrayContaining([
        "list_skill_resources",
        "read_skill_resource",
        "search_skill_resources",
      ]),
    );
  });
});

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

describe("multi-tool assessments", () => {
  const analysis = {
    summary: "Fetches cited sources.",
    risks: [],
    unresolvedReferences: [],
    capabilityRequirements: [
      {
        name: "opinion_store / statute_store (DingDuff fetch tools)",
        kind: "mcp" as const,
        required: true,
        rationale: "Fetches the cited sources.",
      },
    ],
  };
  const catalogue = [
    {
      name: "mcp_dingduff_opinion_store",
      source: "mcp" as const,
      description: "Fetch an opinion.",
      inputSchema: {},
      sideEffects: "external" as const,
      requiresConfirmation: false,
      available: true,
    },
    {
      name: "mcp_dingduff_statute_store",
      source: "mcp" as const,
      description: "Fetch a statute.",
      inputSchema: {},
      sideEffects: "external" as const,
      requiresConfirmation: false,
      available: true,
    },
  ];

  function complete(toolName: string) {
    return async () =>
      JSON.stringify({
        assessments: [
          {
            requirementName: analysis.capabilityRequirements[0].name,
            compatible: true,
            toolName,
            reason: "Both fetch stored sources.",
            comparison: { purpose: "fetch" },
          },
        ],
      });
  }

  it("maps one requirement onto the several tools it needs", async () => {
    // One capability in two calls: the model answers with both names, and
    // mappedToolNames has always been a list.
    const contract = await resolveCapabilityContractWithLlm({
      analysis,
      catalogue,
      model: "gpt-5.4-lite",
      complete: complete(
        "mcp_dingduff_opinion_store and mcp_dingduff_statute_store",
      ) as never,
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toEqual(
      expect.arrayContaining([
        "mcp_dingduff_opinion_store",
        "mcp_dingduff_statute_store",
      ]),
    );
  });

  it("names the catalogue when the assessment invents a tool", async () => {
    await expect(
      resolveCapabilityContractWithLlm({
        analysis,
        catalogue,
        model: "gpt-5.4-lite",
        complete: complete("mcp_dingduff_imaginary_store") as never,
      }),
    ).rejects.toThrow(/Available: mcp_dingduff_opinion_store/);
  });
});

describe("tool names an administrator has to read", () => {
  it("shows an MCP tool as its server and tool, not its wire name", () => {
    // The wire name is a sanitised mcp_<connector>_<tool>_<hash>, which hides
    // which server the tool belongs to.
    const labels = toolDisplayLabels([
      {
        name: "mcp_dingduff_citecheck_review_2500a7a0",
        label: "MCP://DingDuff/citecheck_review",
        source: "mcp",
        description: "Opens the review panel.",
        inputSchema: {},
        sideEffects: "external",
        requiresConfirmation: false,
        available: true,
      },
    ]);
    expect(
      labelForTool("mcp_dingduff_citecheck_review_2500a7a0", labels),
    ).toBe("MCP://DingDuff/citecheck_review");
    // A first-party tool is already readable and is left alone.
    expect(labelForTool("read_document", labels)).toBe("read_document");
  });
});

describe("bundled scripts through the behavioural comparison", () => {
  // Verbatim from the analysis of DingDuff's citation-check skill.
  const NAME =
    "verify_anchors.py / extract_docx.py / mark_pdf_pages.py / build_review.py (bundled scripts, run via python3 shell)";
  const analysis = {
    summary: "Verifies citations.",
    risks: [],
    unresolvedReferences: [],
    capabilityRequirements: [
      {
        name: NAME,
        kind: "first_party_tool" as const,
        required: true,
        rationale: "Runs the bundled verification scripts.",
      },
    ],
  };

  it("stays non-blocking when the comparison finds no equivalent tool", async () => {
    const contract = await resolveCapabilityContractWithLlm({
      analysis,
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: (async () =>
        JSON.stringify({
          assessments: [
            {
              requirementName: NAME,
              compatible: false,
              toolName: null,
              reason: "Nothing here executes scripts.",
              comparison: { purpose: "run scripts" },
            },
          ],
        })) as never,
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.mappings[0].status).toBe("not_executed");
  });

  it("takes the equivalent tool when the comparison finds one", async () => {
    const contract = await resolveCapabilityContractWithLlm({
      analysis,
      catalogue: firstPartyToolCatalogue(),
      model: "gpt-5.4-lite",
      complete: (async () =>
        JSON.stringify({
          assessments: [
            {
              requirementName: NAME,
              compatible: true,
              toolName: "read_document",
              reason: "Extracting document text is read_document's job.",
              comparison: { purpose: "extract text" },
            },
          ],
        })) as never,
    });
    expect(contract.blockers).toEqual([]);
    expect(contract.approvedToolNames).toContain("read_document");
  });
});
