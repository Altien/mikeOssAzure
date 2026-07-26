import {
  PROJECT_EXTRA_TOOLS,
  TOOLS,
} from "../../lib/chat/tools/toolSchemas";
import { createHash } from "node:crypto";
import {
  completeText,
  providerForModel,
  type UserApiKeys,
} from "../../lib/llm";
import type {
  GeneratedSkillAnalysis,
  SkillCapabilityRequirement,
} from "./analysis";
import { AUTHORITY_TRACE_TOOL_NAMES } from "../authorityTrace/chatTools";
import { throwOnDbError, type Db } from "./shared";

export type ToolCatalogueItem = {
  name: string;
  source: "first_party" | "mcp";
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  sideEffects: "read" | "write" | "external" | "unknown";
  requiresConfirmation: boolean;
  available: boolean;
};

export type ApprovedSkillDependency = {
  canonicalName: string;
  displayName: string;
  versionId: string;
  contentHash: string;
};

function catalogueItem(
  schema: unknown,
  source: ToolCatalogueItem["source"],
): ToolCatalogueItem | null {
  const fn = (schema as { function?: Record<string, unknown> })?.function;
  if (!fn || typeof fn.name !== "string") return null;
  const name = fn.name;
  const writeNames = new Set([
    "generate_docx",
    "generate_excel",
    "generate_ppt",
    "edit_document",
    "replicate_document",
  ]);
  const external =
    name.startsWith("courtlistener_") ||
    Object.values(AUTHORITY_TRACE_TOOL_NAMES).includes(
      name as (typeof AUTHORITY_TRACE_TOOL_NAMES)[keyof typeof AUTHORITY_TRACE_TOOL_NAMES],
    ) ||
    name.startsWith("mcp_");
  return {
    name,
    source,
    description: typeof fn.description === "string" ? fn.description : "",
    inputSchema:
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Record<string, unknown>)
        : { type: "object", properties: {} },
    sideEffects: writeNames.has(name)
      ? "write"
      : external
        ? "external"
        : "read",
    requiresConfirmation: false,
    available: true,
  };
}

export function firstPartyToolCatalogue(): ToolCatalogueItem[] {
  const byName = new Map<string, ToolCatalogueItem>();
  for (const schema of [...TOOLS, ...PROJECT_EXTRA_TOOLS]) {
    const item = catalogueItem(schema, "first_party");
    if (item) byName.set(item.name, item);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function inspectMcpToolCatalogue(
  userId: string,
  db: Db,
): Promise<ToolCatalogueItem[]> {
  const result = await db
    .from("user_mcp_connector_tools")
    .select(
      "openai_tool_name, description, input_schema, output_schema, enabled, requires_confirmation, user_mcp_connectors!inner(user_id, enabled)",
    )
    .eq("user_mcp_connectors.user_id", userId);
  throwOnDbError(result);
  return (result.data ?? []).map((row) => {
    const connector = row.user_mcp_connectors as
      | { enabled?: boolean }
      | { enabled?: boolean }[];
    const connectorEnabled = Array.isArray(connector)
      ? connector[0]?.enabled === true
      : connector?.enabled === true;
    return {
      name: String(row.openai_tool_name),
      source: "mcp" as const,
      description: String(row.description ?? ""),
      inputSchema: (row.input_schema ?? {}) as Record<string, unknown>,
      outputSchema: (row.output_schema ?? null) as Record<
        string,
        unknown
      > | null,
      sideEffects: "external" as const,
      requiresConfirmation: row.requires_confirmation === true,
      available:
        connectorEnabled &&
        row.enabled === true &&
        row.requires_confirmation !== true,
    };
  });
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s-]+/g, "_");
}

function vague(requirement: SkillCapabilityRequirement) {
  return /^(appropriate|available|relevant|necessary|needed)?\s*tools?$/i.test(
    requirement.name.trim(),
  );
}

/**
 * Statuses that still need an explicit behavioural comparison before any tool
 * can be granted. They are proposals, never grants.
 */
const UNAPPROVED_STATUSES = ["missing", "proposed"];

export function resolveCapabilityContract(args: {
  analysis: GeneratedSkillAnalysis;
  catalogue: ToolCatalogueItem[];
  skillDependencies?: ApprovedSkillDependency[];
}) {
  const mappings = args.analysis.capabilityRequirements.map((requirement) => {
    if (requirement.kind === "project_read") {
      return {
        requirement,
        status: "compatible" as const,
        mappedToolNames: [
          "list_documents",
          "fetch_documents",
          "read_document",
          "find_in_document",
        ],
        comparison: {
          purpose: "standard read-only project document baseline",
          inputs: "project-scoped document identifiers and literal searches",
          outputs: "bounded document metadata/text",
          sideEffects: "read",
        },
      };
    }
    if (requirement.kind === "model") {
      return {
        requirement,
        status: "model_requirement" as const,
        mappedToolNames: [],
        comparison: { purpose: requirement.rationale },
      };
    }
    if (requirement.kind === "skill") {
      const dependency = (args.skillDependencies ?? []).find(
        (candidate) =>
          normalize(candidate.canonicalName) === normalize(requirement.name) ||
          normalize(candidate.displayName) === normalize(requirement.name),
      );
      return dependency
        ? {
            requirement,
            status: "dependency_compatible" as const,
            mappedToolNames: [],
            comparison: {
              purpose: "exact approved skill-version dependency",
              dependencyName: dependency.displayName,
              versionId: dependency.versionId,
              contentHash: dependency.contentHash,
            },
          }
        : {
            requirement,
            status: "dependency_required" as const,
            mappedToolNames: [],
            comparison: {
              purpose:
                "A named skill requirement must be bound to an exact enabled skill version.",
            },
          };
    }
    if (vague(requirement)) {
      // Story 23: vague naming is not a hard blocker. It grants nothing on its
      // own, and is surfaced as a structured unresolved entry so a TenantAdmin
      // can approve an explicit minimum capability set for it.
      return {
        requirement,
        status: "needs_admin_selection" as const,
        mappedToolNames: [],
        comparison: {
          purpose: "No explicit observable capability.",
          requestedCapabilityText: requirement.name,
          rationale: requirement.rationale,
          adminSelectionRequired:
            "A TenantAdmin must explicitly select the minimum capability set for this requirement; nothing is granted otherwise.",
        },
      };
    }
    const expectedSource =
      requirement.kind === "mcp" ? "mcp" : "first_party";
    const found = args.catalogue.find(
      (item) =>
        item.source === expectedSource &&
        normalize(item.name) === normalize(requirement.name),
    );
    if (!found) {
      return {
        requirement,
        status: "missing" as const,
        mappedToolNames: [],
        comparison: {
          purpose: requirement.rationale,
          inputs: "not comparable: no exact mapped schema",
          outputs: "not comparable: no exact mapped schema",
          sideEffects: "unknown",
        },
      };
    }
    // A mapping requires behavioural compatibility, not name similarity. This
    // deployment holds no canonical identity linking an imported skill's tool
    // name to a Mike tool, so an exact name match is only the first-ranked
    // candidate and needs the same explicit approval as a fuzzy match.
    return {
      requirement,
      status: "proposed" as const,
      mappedToolNames: [found.name],
      comparison: {
        purpose: found.description,
        inputs: found.inputSchema,
        outputs: found.outputSchema ?? "unspecified",
        sideEffects: found.sideEffects,
        requiresConfirmation: found.requiresConfirmation,
        currentlyAvailable: found.available,
        matchBasis: "name equality only; behaviour not yet compared",
      },
    };
  });
  const blockers = mappings.filter(
    (mapping) =>
      mapping.requirement.required &&
      ![
        "compatible",
        "connection_required",
        "model_requirement",
        "dependency_compatible",
        // Not a blocker: it grants nothing and is resolved by explicit
        // TenantAdmin selection of a minimum capability set.
        "needs_admin_selection",
      ].includes(mapping.status),
  );
  const approvedToolNames = Array.from(
    new Set(
      mappings
        .filter((mapping) =>
          ["compatible", "connection_required"].includes(mapping.status),
        )
        .flatMap((mapping) => mapping.mappedToolNames),
    ),
  );
  return {
    projectRequired: true,
    projectRead: mappings.some(
      (mapping) =>
        mapping.requirement.kind === "project_read" &&
        mapping.status === "compatible",
    ),
    approvedToolNames,
    mappings,
    blockers,
    modelRequirements: mappings
      .filter((mapping) => mapping.status === "model_requirement")
      .map((mapping) => mapping.requirement),
    approvedAt: null,
  };
}

function parseFallbackAssessments(raw: string) {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch {
    throw new Error("Fast-model compatibility assessment returned invalid JSON.");
  }
  const assessments = (value as { assessments?: unknown })?.assessments;
  if (!Array.isArray(assessments) || assessments.length > 40) {
    throw new Error("Fast-model compatibility assessment is invalid.");
  }
  return assessments.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Fast-model compatibility assessment is invalid.");
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.requirementName !== "string" ||
      typeof row.compatible !== "boolean" ||
      (row.toolName !== null && typeof row.toolName !== "string") ||
      typeof row.reason !== "string" ||
      !row.comparison ||
      typeof row.comparison !== "object"
    ) {
      throw new Error("Fast-model compatibility assessment is invalid.");
    }
    return {
      requirementName: row.requirementName,
      compatible: row.compatible,
      toolName: row.toolName as string | null,
      reason: row.reason.slice(0, 1_000),
      comparison: row.comparison as Record<string, unknown>,
    };
  });
}

export async function resolveCapabilityContractWithLlm(args: {
  analysis: GeneratedSkillAnalysis;
  catalogue: ToolCatalogueItem[];
  skillDependencies?: ApprovedSkillDependency[];
  model: string;
  apiKeys?: UserApiKeys;
  complete?: typeof completeText;
}) {
  const deterministic = resolveCapabilityContract(args);
  const unresolved = deterministic.mappings.filter(
    (mapping) =>
      UNAPPROVED_STATUSES.includes(mapping.status) &&
      !vague(mapping.requirement),
  );
  if (!unresolved.length) {
    return {
      ...deterministic,
      compatibilityAssessment: null,
    };
  }
  const assessmentInput = {
    requirements: unresolved.map((mapping) => ({
      ...mapping.requirement,
      proposedCandidateNames: mapping.mappedToolNames,
    })),
    candidates: args.catalogue.map((tool) => ({
      name: tool.name,
      source: tool.source,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
      sideEffects: tool.sideEffects,
      requiresConfirmation: tool.requiresConfirmation,
      currentlyAvailable: tool.available,
    })),
  };
  const inputText = JSON.stringify(assessmentInput);
  const inputHash = createHash("sha256").update(inputText).digest("hex");
  const call = args.complete ?? completeText;
  const raw = await call({
    model: args.model,
    apiKeys: args.apiKeys,
    maxTokens: 3_000,
    systemPrompt: `Compare imported skill requirements with tool contracts.
You may choose any first-party or MCP candidate when its observable behaviour
is an acceptable replacement. Compare purpose, inputs, outputs, errors and
limits, data access, and side effects. Name similarity is not evidence.
A requirement may carry proposedCandidateNames: consider those candidates
first, but reject them unless their observable behaviour actually matches.
Never call a tool and never authorize a mapping. Return JSON only:
{"assessments":[{"requirementName":"exact input name","compatible":true,"toolName":"exact candidate name or null","reason":"...","comparison":{"purpose":"...","inputs":"...","outputs":"...","errorsLimits":"...","dataAccess":"...","sideEffects":"..."}}]}`,
    user: inputText,
  });
  const assessments = parseFallbackAssessments(raw);
  const mappings = deterministic.mappings.map((mapping) => {
    if (
      !UNAPPROVED_STATUSES.includes(mapping.status) ||
      vague(mapping.requirement)
    ) {
      return mapping;
    }
    const assessment = assessments.find(
      (item) => item.requirementName === mapping.requirement.name,
    );
    if (!assessment?.compatible || !assessment.toolName) {
      return {
        ...mapping,
        status: "incompatible" as const,
        // Drop any name-matched candidate: it was never behaviourally approved.
        mappedToolNames: [],
        comparison: assessment?.comparison ?? mapping.comparison,
        llmReason: assessment?.reason ?? "No compatible replacement proposed.",
      };
    }
    const candidate = args.catalogue.find(
      (tool) => tool.name === assessment.toolName,
    );
    if (!candidate) {
      throw new Error(
        `Fast-model compatibility assessment selected unknown tool '${assessment.toolName}'.`,
      );
    }
    return {
      ...mapping,
      status: candidate.available
        ? ("llm_compatible" as const)
        : ("connection_required" as const),
      mappedToolNames: [candidate.name],
      comparison: assessment.comparison,
      llmReason: assessment.reason,
      mappedSource: candidate.source,
    };
  });
  const blockers = mappings.filter(
    (mapping) =>
      mapping.requirement.required &&
      ![
        "compatible",
        "llm_compatible",
        "connection_required",
        "model_requirement",
        "dependency_compatible",
        "needs_admin_selection",
      ].includes(mapping.status),
  );
  const approvedToolNames = Array.from(
    new Set(
      mappings
        .filter((mapping) =>
          [
            "compatible",
            "llm_compatible",
            "connection_required",
          ].includes(mapping.status),
        )
        .flatMap((mapping) => mapping.mappedToolNames),
    ),
  );
  return {
    ...deterministic,
    mappings,
    blockers,
    approvedToolNames,
    compatibilityAssessment: {
      provider: providerForModel(args.model),
      model: args.model,
      inputHash,
      schemaVersion: 1,
    },
  };
}
