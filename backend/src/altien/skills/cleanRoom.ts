import { createHash } from "node:crypto";
import {
  completeText,
  providerForModel,
  type UserApiKeys,
} from "../../lib/llm";

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

export function findCleanRoomLeakage(markdown: string, sources: SourceFile[]) {
  const outputWords = normalizedWords(markdown);
  const outputNgrams = new Set<string>();
  for (let index = 0; index <= outputWords.length - 10; index += 1) {
    outputNgrams.add(outputWords.slice(index, index + 10).join(" "));
  }
  const violations: Array<{ path: string; fragment: string }> = [];
  for (const source of sources) {
    const words = normalizedWords(source.text);
    for (let index = 0; index <= words.length - 10; index += 1) {
      const fragment = words.slice(index, index + 10).join(" ");
      if (outputNgrams.has(fragment)) {
        violations.push({ path: source.path, fragment });
        break;
      }
    }
  }
  return violations;
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
  const markdown = `# ${brief.title}

> HUMAN REVIEW REQUIRED — clean-room behavioural draft; no implementation is
> supplied or approved.

## Provenance

- Repository: ${args.provenance.repository ?? "Included import snapshot"}
- Commit: ${args.provenance.commitSha ?? "Snapshot content hash"}
- Source input hash: ${inputHash}
- Source files: ${args.sources.map((source) => `${source.path} (${source.sha256})`).join(", ")}
- Licence files present: ${args.provenance.licencePaths.join(", ") || "none identified"}

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
