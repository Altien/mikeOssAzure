import { createHash } from "node:crypto";
import {
  completeText,
  providerForModel,
  type UserApiKeys,
} from "../../lib/llm";
import { acquireGitHubSkill, parseGitHubSourceUrl } from "./github";
import { getGitHubSkillOAuthToken } from "./githubOAuth";
import { getGitHubSkillImportPolicy } from "./settings";
import type { Db } from "./shared";

type SourceFile = {
  path: string;
  sha256: string;
  text: string;
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

export function findCleanRoomLeakage(markdown: string, sources: SourceFile[]) {
  return evaluateCleanRoomLeakage(markdown, sources, {
    runWords: CLEAN_ROOM_GENERATOR_RUN_WORDS,
  }).violations;
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
  detail?: string;
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
          ? "GITHUB_SKILL_IMPORT_TENANT_DISABLED"
          : "GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED",
      })),
    };
  }

  const acquire = args.acquire ?? acquireGitHubSkill;
  const token =
    (await getGitHubSkillOAuthToken(args.tenantId, args.db)) ?? undefined;
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
    } catch (error) {
      notes.push({
        url,
        status: "skipped_unsupported_link",
        detail: error instanceof Error ? error.message : undefined,
      });
      continue;
    }
    try {
      const acquired = await acquire({ url, token, fetcher: args.fetcher });
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
      notes.push({
        url,
        status: "fetched",
        repository: acquired.provenance.repository,
        commitSha: acquired.provenance.resolvedCommitSha,
        selectedPath: acquired.provenance.selectedPath || undefined,
        fileCount,
        bytes,
      });
    } catch (error) {
      // An unavailable link produces an honest incomplete report, not a
      // failed brief.
      notes.push({
        url,
        status: "unavailable",
        detail: error instanceof Error ? error.message : "Acquisition failed.",
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
  model: string;
  apiKeys?: UserApiKeys;
  complete?: typeof completeText;
}) {
  const sourceInput = args.sources.map((source) => ({
    path: source.path,
    sha256: source.sha256,
    text: source.text,
  }));
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
acceptanceTests, and unknowns.`,
    user: JSON.stringify({
      requirementName: args.requirementName,
      provenance: args.provenance,
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
  const leakage = findCleanRoomLeakage(markdown, args.sources);
  if (leakage.length) {
    throw new Error(
      `Clean-room leakage check failed for ${leakage.map((item) => item.path).join(", ")}.`,
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
