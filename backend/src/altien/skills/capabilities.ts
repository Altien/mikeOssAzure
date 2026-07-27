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
import { SKILL_RESOURCE_TOOLS, SKILL_RESOURCE_TOOL_NAMES } from "./resources";
import type { SkillActionAmendment } from "./actions";
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
  /**
   * What an administrator should read. An MCP tool's wire name is a sanitised
   * `mcp_<connector>_<tool>_<hash>` that says nothing about which server it
   * belongs to; the contract stores the wire name, this is what is shown.
   */
  label?: string;
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
    "write_project_document",
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
  // The skill resource tools belong in the catalogue even though the runtime
  // grants them unconditionally: a skill that says "load my reference file"
  // otherwise names a capability the reviewer cannot see, which reads as a
  // missing requirement and blocks enablement.
  for (const schema of [...TOOLS, ...PROJECT_EXTRA_TOOLS, ...SKILL_RESOURCE_TOOLS]) {
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
      "openai_tool_name, tool_name, description, input_schema, output_schema, enabled, requires_confirmation, user_mcp_connectors!inner(user_id, enabled, name)",
    )
    .eq("user_mcp_connectors.user_id", userId);
  throwOnDbError(result);
  return (result.data ?? []).map((row) => {
    const connector = row.user_mcp_connectors as
      | { enabled?: boolean; name?: string }
      | Array<{ enabled?: boolean; name?: string }>;
    const connectorRow = Array.isArray(connector) ? connector[0] : connector;
    const connectorEnabled = connectorRow?.enabled === true;
    const serverName = String(connectorRow?.name ?? "").trim();
    const toolName = String(row.tool_name ?? row.openai_tool_name);
    return {
      name: String(row.openai_tool_name),
      label: serverName ? `MCP://${serverName}/${toolName}` : toolName,
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

const SKILL_RESOURCE_TOOL_SET = new Set<string>(
  Object.values(SKILL_RESOURCE_TOOL_NAMES),
);

/**
 * True when a requirement is asking to read the skill's own package. Matches
 * the exact tool names first; the prose fallback exists because a model that
 * was not shown these schemas describes them in its own words, and that
 * phrasing must not read as a missing capability.
 *
 * Deliberately ignores `kind`. Models classify this inconsistently — reading
 * the package has been labelled `first_party_tool` and `skill` (as though the
 * package were a separate skill to bind) — and a wrong label must not decide
 * whether a version can be enabled. The requirement text identifies it; a
 * real skill dependency is named after the skill it needs.
 */
function namesSkillResourceTools(requirement: SkillCapabilityRequirement) {
  if (SKILL_RESOURCE_TOOL_SET.has(normalize(requirement.name))) return true;
  return /\bskill\s*resource\b/i.test(requirement.name);
}

/**
 * A requirement to run the package's own bundled code — scripts, a shell, a
 * language runtime. Mike never executes imported source, so no connector,
 * catalogue entry or approval can ever satisfy this: the only route is a
 * clean-room brief and a native tool built from it.
 *
 * Blocking enablement on it is therefore a wall with no door, unlike a
 * missing MCP, which the administrator can simply connect. It grants nothing
 * either way, so it is reported rather than enforced.
 */
function namesLocalExecution(requirement: SkillCapabilityRequirement) {
  return /\b(python3?|shell|bash|node(?:js)?|script execution|bundled scripts?|executables?|subprocess|runtime)\b/i.test(
    requirement.name,
  );
}

/**
 * Words a genuine project-read requirement is made of. The baseline it unlocks
 * is the four read-only document tools, so anything describable with these is
 * already answered by it.
 */
const PROJECT_READ_VOCABULARY = new Set([
  "a", "access", "and", "attached", "attachment", "attachments", "content",
  "contents", "doc", "docs", "document", "documents", "faceted", "file",
  "files", "find", "finding", "for", "from", "in", "list", "listing", "memo",
  "memos", "of", "only", "or", "project", "projects", "read", "reading",
  "reads", "readonly", "retrieval", "retrieve", "search", "searching", "see",
  "source", "sources", "text", "the", "to", "uploaded", "user", "users",
  "with", "workspace", "write",
  "list_documents", "fetch_documents", "read_document", "find_in_document",
  "fetch", "fetching",
]);

/**
 * Whether a requirement the analysis labelled `project_read` actually
 * describes project document access.
 *
 * The label alone cannot be trusted. A real analysis put "Local python3 with
 * bundled scripts (verify_anchors.py, ...)" and "pdftotext (poppler) or
 * equivalent text-layer PDF extractor" under this kind, and the branch it
 * guards grants the document baseline and marks the requirement compatible
 * without any comparison — so a request to run scripts was answered with
 * read_document, silently, and no clean-room brief was ever generated.
 *
 * The test is a whitelist rather than a search for suspicious words: an
 * unfamiliar phrasing falls through to the ordinary path and gets compared,
 * which costs a model call and reaches the same baseline if that is genuinely
 * what it wanted. Guessing the other way grants without looking.
 */
function describesProjectRead(requirement: SkillCapabilityRequirement) {
  if (namesLocalExecution(requirement)) return false;
  // A trailing parenthetical lists examples — file names, paths — while the
  // head carries the claim, so only the head is held to the vocabulary.
  const words = splitRequirementName(requirement.name)
    .parts.join(" ")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 && words.every((word) => PROJECT_READ_VOCABULARY.has(word))
  );
}

/**
 * A requirement for a writable local filesystem — a scratch directory the
 * skill keeps intermediate files in while it works.
 *
 * Mike has no filesystem to lend and no connector, catalogue entry or approval
 * creates one, so this is the same wall with no door as running bundled code.
 * Reported, never enforced: the skill's file steps are answered by adapting it
 * or by a clean-room brief, not by an administrator clicking something.
 */
function namesLocalFilesystem(requirement: SkillCapabilityRequirement) {
  return /\b(file\s?systems?|local (?:disk|directory|folder|path|storage|files?)|working director\w+|scratch (?:space|director\w+)|workspace (?:read|write|access)|temp(?:orary)? (?:director\w+|folder|files?))\b/i.test(
    requirement.name,
  );
}

function vague(requirement: SkillCapabilityRequirement) {
  return /^(appropriate|available|relevant|necessary|needed)?\s*tools?$/i.test(
    requirement.name.trim(),
  );
}

/**
 * Gaps in what this deployment structurally provides, rather than in what an
 * administrator has configured. Nothing anyone approves closes them.
 */
export const STRUCTURAL_GAP_STATUSES = ["not_executed", "not_provided"];

/**
 * Statuses that still need an explicit behavioural comparison before any tool
 * can be granted. They are proposals, never grants.
 */
// The structural gaps are here so they still get a behavioural comparison
// against the catalogue: Mike may already do the job natively, and a script or
// a scratch file is often just a step it has a tool for.
export const UNAPPROVED_STATUSES = [
  "missing",
  "proposed",
  ...STRUCTURAL_GAP_STATUSES,
];

/**
 * Wire name -> what to show an administrator. Only MCP tools differ: their
 * wire name is a sanitised `mcp_<connector>_<tool>_<hash>` that hides which
 * server they came from.
 */
export function toolDisplayLabels(
  catalogue: ToolCatalogueItem[],
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tool of catalogue) {
    if (tool.label && tool.label !== tool.name) labels[tool.name] = tool.label;
  }
  return labels;
}

export function labelForTool(
  name: string,
  labels: Record<string, string> | undefined,
): string {
  return labels?.[name] ?? name;
}

export function resolveCapabilityContract(args: {
  analysis: GeneratedSkillAnalysis;
  catalogue: ToolCatalogueItem[];
  skillDependencies?: ApprovedSkillDependency[];
}) {
  const mappings = args.analysis.capabilityRequirements.map((requirement) => {
    if (requirement.kind === "project_read" && describesProjectRead(requirement)) {
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
    // Reading the skill's own immutable package is granted to every bound
    // version by the runtime, so a requirement that resolves to those tools
    // is a deployment-defined baseline like project_read — not a name match
    // needing approval, and never a reason to block enablement.
    if (namesSkillResourceTools(requirement)) {
      return {
        requirement,
        status: "compatible" as const,
        mappedToolNames: Object.values(SKILL_RESOURCE_TOOL_NAMES),
        comparison: {
          purpose: "skill package resource baseline",
          inputs: "exact package-relative paths and literal searches",
          outputs: "bounded text from the skill's own immutable package",
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
      // Wanting to run bundled code is only unsatisfiable once nothing here
      // does the same job. The behavioural comparison still runs — a script
      // that extracts text from a document may well map onto a Mike tool —
      // and this is the answer when it finds nothing, so it reports the
      // clean-room route instead of blocking on code that will never run.
      if (namesLocalExecution(requirement)) {
        return {
          requirement,
          status: "not_executed" as const,
          mappedToolNames: [],
          comparison: {
            purpose: "Imported executable source is never run.",
            requestedCapabilityText: requirement.name,
            rationale: requirement.rationale,
            cleanRoomPath:
              "No available tool does this. Generate a clean-room brief and build it as a Mike tool; the skill runs without it until then.",
          },
        };
      }
      if (namesLocalFilesystem(requirement)) {
        return {
          requirement,
          status: "not_provided" as const,
          mappedToolNames: [],
          comparison: {
            purpose: "Mike has no local filesystem to lend a skill.",
            requestedCapabilityText: requirement.name,
            rationale: requirement.rationale,
            cleanRoomPath:
              "Project documents replace a scratch directory. The skill's file steps need adapting, or a clean-room brief for whatever the files were for.",
          },
        };
      }
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
  const blockers = mappings.filter(blocksEnablement);
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
    // Display only; the approved set above stays the wire names the runtime
    // filters on.
    toolLabels: toolDisplayLabels(args.catalogue),
    mappings,
    blockers,
    modelRequirements: mappings
      .filter((mapping) => mapping.status === "model_requirement")
      .map((mapping) => mapping.requirement),
    approvedAt: null,
  };
}

/** Statuses that actually contribute tool names to the approved set. */
const GRANTING_STATUSES = [
  "compatible",
  "llm_compatible",
  "connection_required",
  // Story 23: an explicit TenantAdmin minimum capability set.
  "admin_selected",
];

/** Statuses a required requirement may hold without blocking enablement. */
const NON_BLOCKING_STATUSES = [
  ...GRANTING_STATUSES,
  "model_requirement",
  "dependency_compatible",
  "needs_admin_selection",
  // Reported, never enforced: no approval makes Mike execute imported source.
  "not_executed",
  // Nor lend it a filesystem to write scratch files into.
  "not_provided",
  // A deliberate refusal is a decision, not a missing capability.
  "admin_rejected",
];

/**
 * Whether a required capability should stop this version being enabled.
 *
 * Only when the administrator can do something about it. Connecting the MCP
 * server a skill names, binding a skill version it depends on, approving a
 * proposed mapping: those are levers. A gap in Mike's own capabilities is not
 * — no approval makes Mike run python, lend a filesystem, or grow a tool it
 * does not have — so blocking there is a dead end that protects nothing and
 * leaves the skill permanently unenablable.
 *
 * Those gaps are reported instead. The review panel lists every mapping with
 * what it resolved to, so the administrator can see exactly what the skill
 * will be missing and decide whether it is still worth enabling.
 *
 * Deliberately independent of how the requirement was worded. Every earlier
 * version of this rule keyed off the requirement text — bundled scripts, a
 * python3 shell, a workspace, a filesystem — and each re-analysis phrased it
 * differently and broke it. What an administrator can act on does not change
 * with the phrasing.
 */
function blocksEnablement(mapping: {
  requirement: { required?: boolean; kind?: string };
  status: string;
}) {
  if (mapping.requirement.required !== true) return false;
  if (NON_BLOCKING_STATUSES.includes(mapping.status)) return false;
  // Bind the exact skill version it needs.
  if (mapping.status === "dependency_required") return true;
  // Connect the server it names.
  if (mapping.requirement.kind === "mcp") return true;
  // A name match that has not been through its behavioural approval yet: the
  // approval itself is the administrator's lever.
  return mapping.status === "proposed";
}

type StoredContractMapping = {
  requirement: { name: string; required?: boolean; kind?: string };
  status: string;
  mappedToolNames?: unknown;
  comparison?: unknown;
  [key: string]: unknown;
};

function mappedNames(mapping: StoredContractMapping): string[] {
  return Array.isArray(mapping.mappedToolNames)
    ? mapping.mappedToolNames.filter(
        (name): name is string => typeof name === "string" && !!name.trim(),
      )
    : [];
}

function findMapping(
  mappings: StoredContractMapping[],
  name: string,
): StoredContractMapping {
  const found = mappings.find(
    (mapping) => normalize(String(mapping.requirement?.name ?? "")) === normalize(name),
  );
  if (!found) {
    throw new Error(`No reviewed capability requirement is named '${name}'.`);
  }
  return found;
}

/**
 * Applies TenantAdmin amendments to an already-proposed execution contract.
 *
 * Amendments may only narrow or explicitly resolve what the review already
 * displayed: they can select a minimum capability set for an unresolved
 * requirement, refuse a proposed name-match candidate, or restrict the
 * approved tool list to a subset of it. They can never add a tool that was
 * not already approved, and never clear a blocker.
 */
export function applyCapabilityAmendments(args: {
  contract: Record<string, unknown>;
  amendments: SkillActionAmendment[];
  catalogue: ToolCatalogueItem[];
}): { contract: Record<string, unknown>; effects: string[] } {
  const mappings: StoredContractMapping[] = (
    Array.isArray(args.contract.mappings) ? args.contract.mappings : []
  ).map((mapping) => ({ ...(mapping as StoredContractMapping) }));
  const effects: string[] = [];

  const selectable = (mapping: StoredContractMapping, name: string) => {
    if (!["needs_admin_selection", "proposed"].includes(mapping.status)) {
      throw new Error(
        `Requirement '${name}' is already resolved as '${mapping.status}' and cannot be amended.`,
      );
    }
  };

  for (const amendment of args.amendments) {
    if (amendment.kind === "select_capability") {
      const mapping = findMapping(mappings, amendment.requirementName);
      selectable(mapping, amendment.requirementName);
      for (const toolName of amendment.toolNames) {
        const candidate = args.catalogue.find((tool) => tool.name === toolName);
        if (!candidate) {
          throw new Error(`Tool '${toolName}' is not in the tool catalogue.`);
        }
        if (!candidate.available) {
          throw new Error(`Tool '${toolName}' is not currently available.`);
        }
      }
      mapping.status = "admin_selected";
      mapping.mappedToolNames = [...amendment.toolNames];
      mapping.comparison = {
        ...((mapping.comparison as Record<string, unknown>) ?? {}),
        adminSelection: {
          basis: "explicit TenantAdmin minimum capability set",
          selectedToolNames: [...amendment.toolNames],
        },
      };
      effects.push(
        `Explicit minimum capability set for “${amendment.requirementName}”: ${amendment.toolNames.join(", ")}.`,
      );
      continue;
    }
    if (amendment.kind === "reject_capability") {
      const mapping = findMapping(mappings, amendment.requirementName);
      selectable(mapping, amendment.requirementName);
      mapping.status = "admin_rejected";
      mapping.mappedToolNames = [];
      effects.push(
        `Refused every candidate for “${amendment.requirementName}”; the version runs without it.`,
      );
    }
  }

  const approvedFrom = (source: StoredContractMapping[]) =>
    Array.from(
      new Set(
        source
          .filter((mapping) => GRANTING_STATUSES.includes(mapping.status))
          .flatMap((mapping) => mappedNames(mapping)),
      ),
    );
  let approvedToolNames = approvedFrom(mappings);

  const restriction = args.amendments.find(
    (amendment) => amendment.kind === "restrict_tools",
  );
  if (restriction && restriction.kind === "restrict_tools") {
    const unknownName = restriction.toolNames.find(
      (name) => !approvedToolNames.includes(name),
    );
    if (unknownName) {
      throw new Error(
        `An amendment cannot approve '${unknownName}': it was not in the reviewed approved set.`,
      );
    }
    for (const mapping of mappings) {
      if (!GRANTING_STATUSES.includes(mapping.status)) continue;
      const kept = mappedNames(mapping).filter((name) =>
        restriction.toolNames.includes(name),
      );
      if (kept.length) {
        mapping.mappedToolNames = kept;
        continue;
      }
      mapping.status = "admin_rejected";
      mapping.mappedToolNames = [];
    }
    approvedToolNames = approvedFrom(mappings);
    effects.push(
      `Approved tool set restricted to: ${approvedToolNames.length ? approvedToolNames.join(", ") : "none"}.`,
    );
  }

  const blockers = mappings.filter(blocksEnablement);
  if (blockers.length) {
    throw new Error(
      `Required capabilities are missing or unavailable: ${blockers
        .map((mapping) => mapping.requirement.name)
        .join(", ")}.`,
    );
  }
  return {
    contract: {
      ...args.contract,
      mappings,
      approvedToolNames,
      blockers,
      amendments: args.amendments,
      approvedAt: null,
    },
    effects,
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

/**
 * Notes added to a candidate for capability matching only. The chat tool
 * descriptions are written for the assistant mid-conversation and are shared
 * with upstream, so they are not edited here; this says what a matcher needs
 * and nothing else reads it.
 *
 * Every entry exists because a broad tool's own description invites a match
 * that a narrower tool should win. `read_document` says it is what to call
 * before "citing from" a document, which is true in chat and wrong here: an
 * imported skill that verifies citations needs the stable extraction its
 * anchoring depends on, and a plain text read produces quotes anchored to
 * nothing while looking like it worked.
 */
const MATCHER_NOTES: Record<string, string> = {
  read_document:
    "Plain current text of one attached document. Not a verification record: no stable immutable snapshot, no printed-page markers, no structure preservation, no hash. Where the behaviour is citation, quotation, anchoring or page-referenced work, extract_document_for_verification is the correct candidate.",
  fetch_documents:
    "Plain current text of several attached documents, with the same limits as read_document.",
};

/** One narrow behaviour taken out of a requirement, compared on its own. */
type CapabilityAtom = { label: string; intent: string };

type AtomAssessment = {
  atom: CapabilityAtom;
  toolNames: string[];
  reason: string;
  comparison: Record<string, unknown>;
};

/** No honest requirement names more distinct behaviours than this. */
const MAX_ATOMS_PER_REQUIREMENT = 12;
/** Whole-contract ceiling, so one sprawling analysis cannot fan out into cost. */
const MAX_TOTAL_ATOMS = 40;

/**
 * Split a requirement that names several things at once. Analysis models write
 * these as one row — "verify_anchors.py / extract_docx.py / mark_pdf_pages.py
 * (bundled scripts, run via python3 shell)" — and comparing that as a single
 * behaviour asks whether one tool replaces all of them, where the weakest
 * member decides the verdict for every other.
 *
 * A trailing parenthetical is shared context, not another item, so it is
 * lifted off before splitting. `and`/`+` need surrounding whitespace:
 * `find_and_replace` is one tool, not two.
 */
function splitRequirementName(name: string) {
  const trailing = name.match(/\(([^()]*)\)\s*$/);
  const context = trailing ? trailing[1].trim() : "";
  const head = trailing ? name.slice(0, trailing.index).trim() : name.trim();
  const headParts = head
    .split(/\s*[,;/]\s*|\s+(?:and|\+)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (headParts.length > 1) return { parts: headParts, context };
  // The head names one thing and the parenthetical enumerates several: then
  // the list is the behaviours and the head is what they have in common.
  // "Local shell with python3 (scripts verify_anchors.py, extract_docx.py …)"
  // is the same four behaviours as "verify_anchors.py / extract_docx.py …
  // (bundled scripts)", and which way round an analysis writes it changes
  // between runs. Paths keep their slashes here — only a list is a list.
  const listed = context
    .replace(
      /^(?:scripts?|files?|tools?|commands?|e\.?g\.?,?|including|via|using|such as)\s+/i,
      "",
    )
    .split(/\s*[,;]\s*|\s+(?:and|\+)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (listed.length > 1) return { parts: listed, context: head };
  return { parts: headParts.length ? headParts : [head], context };
}

/**
 * Descriptive output only: a malformed reply costs match quality, never the
 * import. Every part keeps its place with the requirement's own rationale as
 * the intent it was going to be compared under anyway.
 */
function parseAtoms(
  raw: string,
  items: string[],
  fallbackIntent: string,
): CapabilityAtom[] {
  const described = new Map<string, string>();
  try {
    const value = JSON.parse(
      raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
    const atoms = (value as { atoms?: unknown })?.atoms;
    if (Array.isArray(atoms)) {
      for (const entry of atoms) {
        const row = entry as Record<string, unknown>;
        if (typeof row?.label === "string" && typeof row?.intent === "string") {
          described.set(normalize(row.label), row.intent.slice(0, 600));
        }
      }
    }
  } catch {
    // Left to the fallback below.
  }
  return items.map((label) => ({
    label,
    intent: described.get(normalize(label)) ?? fallbackIntent,
  }));
}

/**
 * Stage one of our own loop: turn a requirement into the behaviours it
 * actually names. A bare filename tells a comparison nothing, so the model is
 * asked only to say what each part does — a description task, with no
 * catalogue in front of it and no matching decision to make.
 */
async function decomposeRequirement(args: {
  requirement: SkillCapabilityRequirement;
  summary: string;
  model: string;
  apiKeys?: UserApiKeys;
  call: typeof completeText;
}): Promise<CapabilityAtom[]> {
  const { parts, context } = splitRequirementName(args.requirement.name);
  if (parts.length < 2) {
    // Nothing compound to take apart. The requirement's own name stays the
    // label, which is also what a reply keys on.
    return [
      { label: args.requirement.name, intent: args.requirement.rationale },
    ];
  }
  const items = parts.slice(0, MAX_ATOMS_PER_REQUIREMENT);
  const raw = await args.call({
    model: args.model,
    apiKeys: args.apiKeys,
    maxTokens: 1_500,
    reasoningEffort: "low",
    systemPrompt: `State what each named item does. One entry per input item,
same labels, same order. Never merge items and never add items.
Use only the given summary, rationale and shared context. Where they do not
say what an item does, say that plainly instead of guessing.
Return JSON only:
{"atoms":[{"label":"exact input label","intent":"one sentence: the observable behaviour, its inputs, its outputs"}]}`,
    user: JSON.stringify({
      skillSummary: args.summary,
      requirement: args.requirement.name,
      rationale: args.requirement.rationale,
      sharedContext: context,
      items,
    }),
  });
  return parseAtoms(raw, items, args.requirement.rationale);
}

/**
 * Stage two: one behaviour against the whole catalogue, one question, one
 * answer. The chosen names are verified against the catalogue here — the
 * model describes, this code decides what exists.
 */
async function matchAtom(args: {
  atom: CapabilityAtom;
  requirement: SkillCapabilityRequirement;
  proposedCandidateNames: string[];
  candidateText: string;
  catalogue: ToolCatalogueItem[];
  model: string;
  apiKeys?: UserApiKeys;
  call: typeof completeText;
}): Promise<AtomAssessment> {
  const raw = await args.call({
    model: args.model,
    apiKeys: args.apiKeys,
    maxTokens: 1_200,
    // A behavioural comparison against a fixed catalogue; extra reasoning
    // budget invents justifications rather than finding better matches.
    reasoningEffort: "low",
    systemPrompt: `Compare ONE imported skill behaviour with tool contracts.
You may choose any first-party or MCP candidate when its observable behaviour
is an acceptable replacement. Compare purpose, inputs, outputs, errors and
limits, data access, and side effects. Name similarity is not evidence.
The behaviour may carry proposedCandidateNames: consider those first, but
reject them unless their observable behaviour actually matches.
Where more than one candidate could perform the behaviour, take the most
specific one rather than the most general. A general tool that merely returns
the same kind of value is the wrong answer when a narrower candidate produces
the record the behaviour actually needs. A candidate may carry a matchingNote;
it is authoritative about that candidate's limits.
Judge only the behaviour given. Do not consider the rest of the skill, and do
not reject a match because other parts of the skill are unsupported. partOf
names the requirement it came from: use it only to disambiguate between
candidates, never as a reason to reject one.
Never call a tool and never authorize a mapping.
Use exact candidate names as given. Where this one behaviour genuinely needs
several tools, list them comma-separated in toolName. Never invent a name.
Return JSON only:
{"assessments":[{"requirementName":"exact input name","compatible":true,"toolName":"exact candidate name, or several comma-separated, or null","reason":"...","comparison":{"purpose":"...","inputs":"...","outputs":"...","errorsLimits":"...","dataAccess":"...","sideEffects":"..."}}]}`,
    user: JSON.stringify({
      name: args.atom.label,
      behaviour: args.atom.intent,
      kind: args.requirement.kind,
      partOf: args.requirement.name,
      proposedCandidateNames: args.proposedCandidateNames,
      candidates: JSON.parse(args.candidateText),
    }),
  });
  const assessments = parseFallbackAssessments(raw);
  const assessment =
    assessments.find(
      (item) => normalize(item.requirementName) === normalize(args.atom.label),
    ) ??
    // Asked about one behaviour, a lone reply is that behaviour's answer
    // whatever it echoed back as the name. The label is bookkeeping; the tool
    // name below is authority and is checked against the catalogue.
    (assessments.length === 1 ? assessments[0] : undefined);
  if (!assessment?.compatible || !assessment.toolName) {
    return {
      atom: args.atom,
      toolNames: [],
      reason: assessment?.reason ?? "No available tool performs this behaviour.",
      comparison: assessment?.comparison ?? {},
    };
  }
  const selected = String(assessment.toolName)
    .split(/\s*(?:,|;|\/|\band\b|\+)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = selected.filter(
    (name) => !args.catalogue.some((item) => item.name === name),
  );
  if (!selected.length || unknown.length) {
    // Name the catalogue: an assessment that invents a tool is a prompt
    // problem, and the reviewer can only judge it against what exists.
    throw new Error(
      `Fast-model compatibility assessment selected unknown tool ${unknown
        .map((name) => `'${name}'`)
        .join(", ")} for '${args.atom.label}'. Available: ${args.catalogue
        .map((tool) => tool.name)
        .join(", ")}.`,
    );
  }
  return {
    atom: args.atom,
    toolNames: selected,
    reason: assessment.reason,
    comparison: assessment.comparison,
  };
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
  const candidateText = JSON.stringify(
    args.catalogue.map((tool) => ({
      name: tool.name,
      source: tool.source,
      description: tool.description,
      ...(MATCHER_NOTES[tool.name]
        ? { matchingNote: MATCHER_NOTES[tool.name] }
        : {}),
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
      sideEffects: tool.sideEffects,
      requiresConfirmation: tool.requiresConfirmation,
      currentlyAvailable: tool.available,
    })),
  );
  const call = args.complete ?? completeText;

  // Our own loop, deliberately not an agentic one. Decomposing a requirement
  // and matching every part of it in a single reply is the thing these models
  // are worst at, so the control flow lives here: split, then ask one narrow
  // question per behaviour, then combine the answers in code.
  const assessed = new Map<string, AtomAssessment[]>();
  const audit: unknown[] = [];
  let remainingAtoms = MAX_TOTAL_ATOMS;
  for (const mapping of unresolved) {
    if (remainingAtoms <= 0) break;
    const atoms = (
      await decomposeRequirement({
        requirement: mapping.requirement,
        summary: args.analysis.summary,
        model: args.model,
        apiKeys: args.apiKeys,
        call,
      })
    ).slice(0, remainingAtoms);
    remainingAtoms -= atoms.length;
    const results = await Promise.all(
      atoms.map((atom) =>
        matchAtom({
          atom,
          requirement: mapping.requirement,
          proposedCandidateNames: mapping.mappedToolNames,
          candidateText,
          catalogue: args.catalogue,
          model: args.model,
          apiKeys: args.apiKeys,
          call,
        }),
      ),
    );
    assessed.set(mapping.requirement.name, results);
    audit.push({ requirement: mapping.requirement.name, atoms });
  }
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ atoms: audit, candidates: candidateText }))
    .digest("hex");

  const mappings = deterministic.mappings.map((mapping) => {
    if (
      !UNAPPROVED_STATUSES.includes(mapping.status) ||
      vague(mapping.requirement)
    ) {
      return mapping;
    }
    const results = assessed.get(mapping.requirement.name);
    if (!results?.length) return mapping;
    // What each part of the requirement resolved to, kept on the mapping so a
    // reviewer and a clean-room brief can see the two-thirds Mike already
    // covers instead of one verdict for the whole lump.
    const atoms = results.map((result) => ({
      label: result.atom.label,
      intent: result.atom.intent,
      mappedToolNames: result.toolNames,
      reason: result.reason,
    }));
    const matched = results.filter((result) => result.toolNames.length);
    if (matched.length < results.length) {
      // Partial cover is not cover: a requirement is satisfied when every
      // behaviour it names is. For a structural gap that is the expected
      // answer rather than a failure, so it keeps its status and its
      // clean-room route.
      if (STRUCTURAL_GAP_STATUSES.includes(mapping.status)) {
        return {
          ...mapping,
          atoms,
          llmReason: matched.length
            ? `${matched.length} of ${results.length} behaviours already exist as Mike tools: ${matched
                .map(
                  (result) =>
                    `${result.atom.label} → ${result.toolNames.join(", ")}`,
                )
                .join("; ")}.`
            : (results[0]?.reason ??
              "No available tool performs this behaviour."),
        };
      }
      return {
        ...mapping,
        status: "incompatible" as const,
        // Drop any name-matched candidate: it was never behaviourally approved.
        mappedToolNames: [],
        atoms,
        comparison: results[0]?.comparison ?? mapping.comparison,
        llmReason: matched.length
          ? `Only ${matched.length} of ${results.length} named behaviours have an equivalent here.`
          : (results[0]?.reason ?? "No compatible replacement proposed."),
      };
    }
    // Every named behaviour has an equivalent — including a bundled script
    // set that turns out to be entirely covered natively, which is exactly
    // the case worth catching.
    const toolNames = Array.from(
      new Set(matched.flatMap((result) => result.toolNames)),
    );
    const tools = toolNames.map(
      (name) => args.catalogue.find((item) => item.name === name)!,
    );
    return {
      ...mapping,
      status: tools.every((tool) => tool.available)
        ? ("llm_compatible" as const)
        : ("connection_required" as const),
      mappedToolNames: toolNames,
      atoms,
      comparison: results[0].comparison,
      llmReason: results.map((result) => result.reason).join(" "),
      mappedSource: tools[0].source,
    };
  });
  const blockers = mappings.filter(blocksEnablement);
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
