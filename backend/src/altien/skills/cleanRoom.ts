import { createHash } from "node:crypto";
import {
  completeText,
  providerForModel,
  type UserApiKeys,
} from "../../lib/llm";
import { acquireGitHubSkill, parseGitHubSourceUrl } from "./github";
import { getGitHubSkillImportPolicy } from "./settings";
import type { Db } from "./shared";

type SourceFile = {
  path: string;
  sha256: string;
  text: string;
};

/**
 * What the capability matcher already worked out about a requirement, broken
 * down by the individual behaviours it names.
 *
 * A requirement like "Local shell with python3 (verify_anchors.py,
 * extract_docx.py, mark_pdf_pages.py, build_review.py)" resolves per script,
 * and three of those four already have Mike tools. Without this the generator
 * is told only the requirement's name and specifies all four, so the one real
 * gap arrives buried in three-quarters of work nobody needs to do — and a
 * brief that respecifies an existing tool is an invitation to build a
 * duplicate of it.
 */
export type CleanRoomCoverage = {
  /** Behaviours with a Mike tool already, and the tools they resolved to. */
  covered: { label: string; toolNames: string[] }[];
  /** Behaviours nothing here performs. These are what a brief is for. */
  uncovered: { label: string; intent: string }[];
};

type CleanRoomJson = {
  title: string;
  purpose: string;
  inputs: string[];
  outputs: string[];
  errorsAndLimits: string[];
  sideEffects: string[];
  networkAndDataAccess: string[];
  securityRequirements: string[];
  stateAndConcurrency: string[];
  proposedToolSchema: Record<string, unknown>;
  acceptanceTests: string[];
  unknowns: string[];
};

function list(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > 40) {
    throw new Error(`Invalid clean-room field '${field}'.`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 1_000) {
      throw new Error(`Invalid clean-room field '${field}'.`);
    }
    return item.trim();
  });
}

function parse(raw: string): CleanRoomJson {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Clean-room generator returned invalid JSON.");
  }
  const row = value as Record<string, unknown>;
  if (
    !row ||
    typeof row.title !== "string" ||
    typeof row.purpose !== "string" ||
    !row.proposedToolSchema ||
    typeof row.proposedToolSchema !== "object"
  ) {
    throw new Error("Clean-room generator returned invalid JSON.");
  }
  return {
    title: row.title.slice(0, 200),
    purpose: row.purpose.slice(0, 3_000),
    inputs: list(row.inputs, "inputs"),
    outputs: list(row.outputs, "outputs"),
    errorsAndLimits: list(row.errorsAndLimits, "errorsAndLimits"),
    sideEffects: list(row.sideEffects, "sideEffects"),
    networkAndDataAccess: list(
      row.networkAndDataAccess,
      "networkAndDataAccess",
    ),
    securityRequirements: list(
      row.securityRequirements,
      "securityRequirements",
    ),
    stateAndConcurrency: list(
      row.stateAndConcurrency,
      "stateAndConcurrency",
    ),
    proposedToolSchema: row.proposedToolSchema as Record<string, unknown>,
    acceptanceTests: list(row.acceptanceTests, "acceptanceTests"),
    unknowns: list(row.unknowns, "unknowns"),
  };
}

function normalizedWords(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

/**
 * Word run compared when a generated brief is checked against the whole
 * original snapshot rather than the files the generator was shown. Forty
 * normalized words is roughly 200 characters of prose — long enough that a
 * match is verbatim copying rather than shared vocabulary.
 */
export const CLEAN_ROOM_SNAPSHOT_RUN_WORDS = 40;

/** Word run compared against the files handed to the generator. */
export const CLEAN_ROOM_GENERATOR_RUN_WORDS = 10;

export type CleanRoomLeakageViolation = {
  path: string;
  fragment: string;
  words: number;
};

export type CleanRoomLeakageResult = {
  passed: boolean;
  runWords: number;
  violations: CleanRoomLeakageViolation[];
};

/**
 * Deterministic verbatim-span check: any normalized word run of `runWords`
 * that appears in both the generated text and a source file is reported. No
 * model is involved, so the same inputs always produce the same verdict.
 */
export function evaluateCleanRoomLeakage(
  markdown: string,
  sources: SourceFile[],
  options: { runWords?: number } = {},
): CleanRoomLeakageResult {
  const runWords = options.runWords ?? CLEAN_ROOM_GENERATOR_RUN_WORDS;
  const outputWords = normalizedWords(markdown);
  const outputRuns = new Set<string>();
  for (let index = 0; index <= outputWords.length - runWords; index += 1) {
    outputRuns.add(outputWords.slice(index, index + runWords).join(" "));
  }
  const violations: CleanRoomLeakageViolation[] = [];
  for (const source of sources) {
    const words = normalizedWords(source.text);
    for (let index = 0; index <= words.length - runWords; index += 1) {
      const fragment = words.slice(index, index + runWords).join(" ");
      if (outputRuns.has(fragment)) {
        violations.push({ path: source.path, fragment, words: runWords });
        break;
      }
    }
  }
  return { passed: violations.length === 0, runWords, violations };
}

/**
 * Explicit `github.com` links the clean-room pipeline may follow, and the
 * budget it may spend doing so. The spec allows following declared source
 * links "through the same gated, bounded, commit-pinned acquisition service";
 * these are the extra bounds this pipeline applies on top of the acquisition
 * service's own import limits.
 */
export const CLEAN_ROOM_LINKED_SOURCE_LIMITS = {
  /** Distinct github.com links followed for one brief. */
  links: 2,
  /** Text files taken from each acquired snapshot. */
  filesPerLink: 20,
  /** Total linked-source text added to the leakage corpus. */
  totalBytes: 256 * 1024,
} as const;

/**
 * The only values `detail` may take. A note travels into the clean-room
 * generator prompt, so nothing derived from skill content or from an upstream
 * service's error text may appear in it: a fixed vocabulary closes that
 * injection channel by construction. It also means a private or non-existent
 * repository reads identically — simply unavailable — so a note cannot be used
 * to probe which repositories exist.
 */
export const CLEAN_ROOM_LINK_NOTE_DETAILS = {
  tenantDisabled: "GITHUB_SKILL_IMPORT_TENANT_DISABLED",
  deploymentDenied: "GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED",
  unavailable: "GITHUB_SKILL_LINK_UNAVAILABLE",
  unsupportedLink: "GITHUB_SKILL_LINK_UNSUPPORTED_FORM",
} as const;

export type CleanRoomLinkNoteDetail =
  (typeof CLEAN_ROOM_LINK_NOTE_DETAILS)[keyof typeof CLEAN_ROOM_LINK_NOTE_DETAILS];

export type CleanRoomLinkedSourceNote = {
  url: string;
  status:
    | "fetched"
    | "skipped_gate_denied"
    | "skipped_link_budget"
    | "skipped_unsupported_link"
    | "unavailable";
  repository?: string;
  commitSha?: string;
  selectedPath?: string;
  fileCount?: number;
  bytes?: number;
  detail?: CleanRoomLinkNoteDetail;
};

const GITHUB_LINK = /https:\/\/github\.com\/[A-Za-z0-9._~\-/]+/gi;

/**
 * Explicit github.com links declared by snapshot content. Only whole links
 * written literally in the inspected text count — nothing is inferred from a
 * package name, a registry reference, or a bare owner/repo mention.
 */
export function findExplicitGitHubSourceLinks(
  sources: readonly SourceFile[],
): string[] {
  const links = new Set<string>();
  for (const source of sources) {
    for (const match of source.text.matchAll(GITHUB_LINK)) {
      const url = match[0].replace(/[.,;:)\]}'"]+$/, "").replace(/\/+$/, "");
      if (url.split("/").length >= 5) links.add(url);
    }
  }
  return [...links];
}

/**
 * Follows explicit github.com source links through the ordinary gated
 * acquisition service and returns their text for the leakage corpus.
 *
 * The gates are not re-implemented here: the same deployment + tenant policy
 * that governs GitHub skill import governs this, and the fetch itself is
 * `acquireGitHubSkill`, so host restriction, redirect handling, commit
 * pinning, and import limits are exactly the import path's. A denied gate is
 * not an error — the brief is still generated, with the skip recorded in its
 * provenance notes.
 *
 * The fetch is deliberately anonymous. The links come from uploaded skill
 * content, so authenticating them with the tenant's repo-scoped OAuth token
 * would make this a confused deputy: an uploaded archive could name a private
 * repository and have its contents pulled into the leakage corpus, or probe
 * which private repositories exist. Public repositories are all a declared
 * source link may reach; anything else is simply unavailable.
 */
export async function collectCleanRoomGitHubSources(args: {
  tenantId: string;
  sources: readonly SourceFile[];
  db: Db;
  /** Test seam; defaults to the gated acquisition service. */
  acquire?: typeof acquireGitHubSkill;
  fetcher?: typeof fetch;
}): Promise<{ sources: SourceFile[]; notes: CleanRoomLinkedSourceNote[] }> {
  const links = findExplicitGitHubSourceLinks(args.sources);
  if (!links.length) return { sources: [], notes: [] };

  const policy = await getGitHubSkillImportPolicy(args.tenantId, args.db);
  if (!policy.effectiveEnabled) {
    return {
      sources: [],
      notes: links.map((url) => ({
        url,
        status: "skipped_gate_denied" as const,
        detail: policy.deploymentAllowed
          ? CLEAN_ROOM_LINK_NOTE_DETAILS.tenantDisabled
          : CLEAN_ROOM_LINK_NOTE_DETAILS.deploymentDenied,
      })),
    };
  }

  const acquire = args.acquire ?? acquireGitHubSkill;
  const notes: CleanRoomLinkedSourceNote[] = [];
  const collected: SourceFile[] = [];
  let budget = CLEAN_ROOM_LINKED_SOURCE_LIMITS.totalBytes;

  for (const [index, url] of links.entries()) {
    if (index >= CLEAN_ROOM_LINKED_SOURCE_LIMITS.links) {
      notes.push({ url, status: "skipped_link_budget" });
      continue;
    }
    try {
      parseGitHubSourceUrl(url);
    } catch {
      notes.push({
        url,
        status: "skipped_unsupported_link",
        detail: CLEAN_ROOM_LINK_NOTE_DETAILS.unsupportedLink,
      });
      continue;
    }
    try {
      // No tenant token: see the anonymous-fetch note above.
      const acquired = await acquire({
        url,
        token: undefined,
        fetcher: args.fetcher,
      });
      let fileCount = 0;
      let bytes = 0;
      for (const file of acquired.snapshot.files) {
        if (fileCount >= CLEAN_ROOM_LINKED_SOURCE_LIMITS.filesPerLink) break;
        if (
          file.inspectionClass !== "source" &&
          file.inspectionClass !== "text"
        ) {
          continue;
        }
        if (file.byteSize > budget) break;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
        } catch {
          // Not decodable as UTF-8, so it cannot leak as verbatim text.
          continue;
        }
        collected.push({
          path: `${acquired.provenance.repository}@${acquired.provenance.resolvedCommitSha}/${file.relativePath}`,
          sha256: file.sha256,
          text,
        });
        fileCount += 1;
        bytes += file.byteSize;
        budget -= file.byteSize;
      }
      // An absent optional key is omitted rather than set to `undefined`:
      // these notes are hashed as part of the artifact approval payload, and
      // an `undefined` value would not survive the jsonb round-trip.
      notes.push({
        url,
        status: "fetched",
        repository: acquired.provenance.repository,
        commitSha: acquired.provenance.resolvedCommitSha,
        ...(acquired.provenance.selectedPath
          ? { selectedPath: acquired.provenance.selectedPath }
          : {}),
        fileCount,
        bytes,
      });
    } catch {
      // An unavailable link produces an honest incomplete report, not a
      // failed brief. Private, missing, and failed-fetch all read the same,
      // so the note cannot report anything the uploader did not already know.
      notes.push({
        url,
        status: "unavailable",
        detail: CLEAN_ROOM_LINK_NOTE_DETAILS.unavailable,
      });
    }
  }
  return { sources: collected, notes };
}

function section(title: string, values: string[]) {
  return `## ${title}\n\n${
    values.length ? values.map((value) => `- ${value}`).join("\n") : "- None identified."
  }`;
}

export async function generateCleanRoomBrief(args: {
  requirementName: string;
  provenance: {
    repository?: string;
    commitSha?: string;
    licencePaths: string[];
    /** Explicit github.com links followed through the gated service. */
    linkedSources?: CleanRoomLinkedSourceNote[];
  };
  sources: SourceFile[];
  /** Absent when no contract has been resolved for this version yet. */
  coverage?: CleanRoomCoverage;
  model: string;
  apiKeys?: UserApiKeys;
  complete?: typeof completeText;
}) {
  const sourceInput = args.sources.map((source) => ({
    path: source.path,
    sha256: source.sha256,
    text: source.text,
  }));
  const coverage = args.coverage;
  // Only worth scoping when the matcher actually found something. All-uncovered
  // is the same brief either way, and saying "specify nothing" when everything
  // is covered would produce an empty document rather than a useful one — the
  // caller decides whether a fully covered requirement needs a brief at all.
  const scoped = !!coverage?.covered.length && !!coverage.uncovered.length;
  const scopeInstruction = scoped
    ? `\nThis deployment already performs some of what this requirement names.
Specify ONLY these behaviours: ${coverage.uncovered
        .map((atom) => `${atom.label} (${atom.intent})`)
        .join("; ")}.
Do not specify these, which already exist as tools here: ${coverage.covered
        .map((atom) => `${atom.label} → ${atom.toolNames.join(", ")}`)
        .join("; ")}.
Reference an existing tool by name where the behaviour you are specifying
depends on it, but do not restate its contract.`
    : "";
  const inputHash = createHash("sha256")
    .update(JSON.stringify(sourceInput))
    .digest("hex");
  const call = args.complete ?? completeText;
  const raw = await call({
    model: args.model,
    apiKeys: args.apiKeys,
    maxTokens: 4_000,
    systemPrompt: `Write a clean-room behavioural specification from source.
Do not reproduce source code, comments, prompt prose, examples, identifiers
that are not necessary to the public contract, or implementation structure.
Describe only observable behaviour. Return JSON with title, purpose, inputs,
outputs, errorsAndLimits, sideEffects, networkAndDataAccess,
securityRequirements, stateAndConcurrency, proposedToolSchema,
acceptanceTests, and unknowns.${scopeInstruction}`,
    user: JSON.stringify({
      requirementName: args.requirementName,
      provenance: args.provenance,
      ...(scoped
        ? {
            specifyOnly: coverage.uncovered,
            alreadyProvided: coverage.covered,
          }
        : {}),
      sources: sourceInput,
    }),
  });
  const brief = parse(raw);
  const notes = args.provenance.linkedSources ?? [];
  const linkedSourceProvenance = notes.length
    ? notes
        .map((note) =>
          note.status === "fetched"
            ? `${note.repository}@${note.commitSha} (${note.fileCount} file(s), via ${note.url})`
            : `${note.url} — ${note.status}`,
        )
        .join("; ")
    : "none declared";
  const markdown = `# ${brief.title}

> HUMAN REVIEW REQUIRED — clean-room behavioural draft; no implementation is
> supplied or approved.

## Provenance

- Repository: ${args.provenance.repository ?? "Included import snapshot"}
- Commit: ${args.provenance.commitSha ?? "Snapshot content hash"}
- Source input hash: ${inputHash}
- Source files: ${args.sources.map((source) => `${source.path} (${source.sha256})`).join(", ")}
- Licence files present: ${args.provenance.licencePaths.join(", ") || "none identified"}
- Linked GitHub sources: ${linkedSourceProvenance}
${
  scoped
    ? `
## Scope

This requirement names several behaviours. This brief specifies only the ones
nothing here performs; the rest are listed so no one builds them twice.

${coverage.uncovered.map((atom) => `- **Specified here** — ${atom.label}: ${atom.intent}`).join("\n")}
${coverage.covered.map((atom) => `- Already provided by ${atom.toolNames.join(", ")} — ${atom.label}`).join("\n")}
`
    : ""
}
## Observable purpose

${brief.purpose}

${section("Inputs", brief.inputs)}

${section("Outputs", brief.outputs)}

${section("Errors and limits", brief.errorsAndLimits)}

${section("Side effects", brief.sideEffects)}

${section("Network and data access", brief.networkAndDataAccess)}

${section("Security and authorization", brief.securityRequirements)}

${section("State and concurrency", brief.stateAndConcurrency)}

## Proposed Mike tool schema

\`\`\`json
${JSON.stringify(brief.proposedToolSchema, null, 2)}
\`\`\`

${section("Black-box acceptance tests", brief.acceptanceTests)}

${section("Unknowns", brief.unknowns)}
`;
  const leakage = evaluateCleanRoomLeakage(markdown, args.sources, {
    runWords: CLEAN_ROOM_GENERATOR_RUN_WORDS,
  });
  if (!leakage.passed) {
    throw new Error(
      `Clean-room leakage check failed for ${leakage.violations
        .map((item) => item.path)
        .join(", ")}.`,
    );
  }
  return {
    markdown,
    provenance: {
      provider: providerForModel(args.model),
      model: args.model,
      inputHash,
      schemaVersion: 1,
    },
  };
}
