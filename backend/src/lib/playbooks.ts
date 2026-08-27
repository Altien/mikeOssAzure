import crypto from "node:crypto";
const { jsonrepair } = require("jsonrepair") as {
    jsonrepair: (text: string) => string;
};
import { z } from "zod";
import {
  createServerDatabase,
  databaseProviderIsSQLite,
  type ServerDatabase,
} from "./database";
import { getSqliteDb } from "./sqlite";
import { completeText, type UserApiKeys } from "./llm";
import {
  builtInModelIds,
  DEFAULT_MAIN_MODEL,
  providerForModel,
} from "./llm/models";
import {
  apiKeyForConfiguredModel,
  configuredModelSummaries,
  getCommitteeModel,
  getConfiguredModel,
} from "./llm/registry";
import { isOpenRouterModelId } from "./llm/openrouterCatalog";
import { getUserApiKeys } from "./userApiKeys";
import {
  featureForModel,
  normalizeUserFeatures,
  type UserFeatures,
} from "./userFeatures";
import { deleteFile, uploadFile } from "./storage";
import {
  extractPlaybookWordStructure,
  type PlaybookWordStructure,
} from "./playbookWord";

type Db = ServerDatabase;

const DEFAULT_PLAYBOOK_COMPILATION_TIMEOUT_MS = 300_000;

const clauseSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  usage: z
    .enum(["illustrative", "preferred", "verbatim", "accepted", "unacceptable"])
    .default("illustrative"),
  sourceRefs: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
});

const positionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  criteria: z.string().trim().min(1).max(20_000),
  sampleClauses: z.array(clauseSchema).max(30).default([]),
});

const ruleSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(300),
  concept: z.string().trim().min(1).max(20_000),
  scope: z.enum(["clause", "agreement"]).default("clause"),
  required: z.boolean().default(false),
  guidance: z.string().trim().max(20_000).default(""),
  standard: positionSchema.nullable().default(null),
  fallbacks: z.array(positionSchema).max(20).default([]),
  unacceptable: z.array(positionSchema).max(20).default([]),
  conditions: z.array(z.string().trim().min(1).max(2_000)).max(30).default([]),
  actions: z
    .array(
      z.object({
        scenario: z.string().trim().max(2_000).default(""),
        instruction: z.string().trim().min(1).max(5_000),
      }),
    )
    .max(20)
    .default([]),
  sourceRefs: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

const topicSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(300),
  rules: z.array(ruleSchema).min(1).max(200),
});

export const playbookContentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(""),
  globalGuidance: z.string().trim().max(20_000).default(""),
  representedParty: z.string().trim().max(300).default(""),
  documentTypes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  jurisdictions: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  topics: z.array(topicSchema).min(1).max(200),
});

const findingSchema = z.object({
  topicId: z.string().trim().max(100).nullable().default(null),
  ruleId: z.string().trim().max(100).nullable().default(null),
  ruleName: z.string().trim().min(1).max(300),
  status: z.enum([
    "not_applicable",
    "acceptable",
    "needs_review",
    "unacceptable",
    "missing_required",
    "outside_scope",
  ]),
  quote: z.string().trim().max(30_000).default(""),
  location: z.string().trim().max(500).default(""),
  analysis: z.string().trim().min(1).max(20_000),
  suggestedText: z.string().trim().max(30_000).default(""),
});

const reviewSchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  findings: z.array(findingSchema).max(1000),
});

export type PlaybookContent = z.infer<typeof playbookContentSchema>;
export type PlaybookFinding = z.infer<typeof findingSchema> & { id: string };

export type Playbook = {
  id: string;
  userId: string;
  name: string;
  description: string;
  status: "draft" | "published";
  draft: PlaybookContent;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  publishedName: string | null;
  sourceFilename: string | null;
  importModel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlaybookImportStage =
  | "validating_file"
  | "checking_model"
  | "extracting_word"
  | "compiling"
  | "validating_output"
  | "repairing_output"
  | "storing_source"
  | "saving_playbook"
  | "completed";

export class PlaybookImportError extends Error {
  readonly code = "PLAYBOOK_IMPORT_FAILED";

  constructor(
    message: string,
    readonly attemptId: string,
    readonly stage: PlaybookImportStage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlaybookImportError";
  }
}

let schemaReady = false;

export function ensurePlaybookSchema(): void {
  if (!databaseProviderIsSQLite()) return;
  if (schemaReady) return;
  getSqliteDb().exec(`
    create table if not exists playbooks (
      id text primary key,
      user_id text not null,
      name text not null,
      description text not null default '',
      status text not null default 'draft',
      draft_json text not null,
      published_version_id text,
      source_filename text,
      source_storage_key text,
      source_structure_json text,
      import_model text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_playbooks_user_updated on playbooks(user_id, updated_at desc);
    create table if not exists playbook_versions (
      id text primary key,
      playbook_id text not null,
      user_id text not null,
      version_number integer not null,
      content_json text not null,
      created_at text not null,
      unique(playbook_id, version_number)
    );
    create index if not exists idx_playbook_versions_playbook on playbook_versions(playbook_id, version_number desc);
    create table if not exists playbook_runs (
      id text primary key,
      playbook_id text not null,
      version_id text not null,
      user_id text not null,
      model text not null,
      document_name text,
      review_mode text not null,
      status text not null,
      summary text,
      findings_json text,
      error text,
      started_at text not null,
      completed_at text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_playbook_runs_playbook on playbook_runs(playbook_id, started_at desc);
    create table if not exists playbook_imports (
      id text primary key,
      user_id text not null,
      filename text not null,
      requested_name text,
      model text not null,
      status text not null,
      stage text not null,
      error text,
      playbook_id text,
      started_at text not null,
      completed_at text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_playbook_imports_user_started on playbook_imports(user_id, started_at desc);
  `);
  schemaReady = true;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseModelJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return JSON.parse(jsonrepair(slice));
      }
    }
    throw new Error("The model did not return structured JSON.");
  }
}

function conditionObjectText(value: Record<string, unknown>): string {
  const entries = Object.entries(value).filter(
    ([, entry]) => entry !== null && entry !== undefined && entry !== "",
  );
  if (entries.length === 1 && typeof entries[0][1] === "string") {
    return entries[0][1].trim();
  }
  return entries
    .map(([key, entry]) => {
      const label = key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .replace(/^./, (character) => character.toUpperCase());
      const text =
        typeof entry === "string" ? entry.trim() : JSON.stringify(entry);
      return `${label}: ${text}`;
    })
    .join("; ");
}

export function normalizeCompiledPlaybookOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const playbook = value as Record<string, unknown>;
  if (!Array.isArray(playbook.topics)) return value;
  return {
    ...playbook,
    topics: playbook.topics.map((topic) => {
      if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
        return topic;
      }
      const topicRecord = topic as Record<string, unknown>;
      if (!Array.isArray(topicRecord.rules)) return topic;
      return {
        ...topicRecord,
        rules: topicRecord.rules.map((rule) => {
          if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            return rule;
          }
          const ruleRecord = rule as Record<string, unknown>;
          if (!Array.isArray(ruleRecord.conditions)) return rule;
          return {
            ...ruleRecord,
            conditions: ruleRecord.conditions.map((condition) =>
              condition &&
              typeof condition === "object" &&
              !Array.isArray(condition)
                ? conditionObjectText(condition as Record<string, unknown>)
                : condition,
            ),
          };
        }),
      };
    }),
  };
}

function validateCompiledPlaybookOutput(
  raw: string,
  structure: PlaybookWordStructure,
): PlaybookContent {
  return validateImportedSources(
    stableIds(
      playbookContentSchema.parse(
        normalizeCompiledPlaybookOutput(parseModelJson(raw)),
      ),
    ),
    structure,
  );
}

function validationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

export async function validatePlaybookCompilationWithRetry(args: {
  raw: string;
  structure: PlaybookWordStructure;
  retry: (validationError: string) => Promise<string>;
}): Promise<PlaybookContent> {
  try {
    return validateCompiledPlaybookOutput(args.raw, args.structure);
  } catch (firstError) {
    const repaired = await args.retry(validationErrorMessage(firstError));
    try {
      return validateCompiledPlaybookOutput(repaired, args.structure);
    } catch (retryError) {
      throw new Error(
        `The selected model returned invalid structured output twice. ${validationErrorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

function stableIds(content: PlaybookContent): PlaybookContent {
  return {
    ...content,
    topics: content.topics.map((topic, topicIndex) => ({
      ...topic,
      id: topic.id || `topic-${topicIndex + 1}`,
      rules: topic.rules.map((rule, ruleIndex) => ({
        ...rule,
        id: rule.id || `topic-${topicIndex + 1}-rule-${ruleIndex + 1}`,
      })),
    })),
  };
}

function validateImportedSources(
  content: PlaybookContent,
  structure: PlaybookWordStructure,
): PlaybookContent {
  const available = new Set(structure.sources.map((source) => source.id));
  const filter = (refs: string[]) => [
    ...new Set(refs.filter((ref) => available.has(ref))),
  ];
  return {
    ...content,
    topics: content.topics.map((topic) => ({
      ...topic,
      rules: topic.rules.map((rule) => {
        const standard = rule.standard
          ? {
              ...rule.standard,
              sampleClauses: rule.standard.sampleClauses.map((clause) => ({
                ...clause,
                sourceRefs: filter(clause.sourceRefs),
              })),
            }
          : null;
        const mapPositions = (
          positions: PlaybookContent["topics"][number]["rules"][number]["fallbacks"],
        ) =>
          positions.map((position) => ({
            ...position,
            sampleClauses: position.sampleClauses.map((clause) => ({
              ...clause,
              sourceRefs: filter(clause.sourceRefs),
            })),
          }));
        const fallbacks = mapPositions(rule.fallbacks);
        const unacceptable = mapPositions(rule.unacceptable);
        const clauseRefs = [standard, ...fallbacks, ...unacceptable]
          .filter((position): position is PlaybookPosition => !!position)
          .flatMap((position) =>
            position.sampleClauses.flatMap((clause) => clause.sourceRefs),
          );
        const sourceRefs = filter([...rule.sourceRefs, ...clauseRefs]);
        if (!sourceRefs.length) {
          throw new Error(
            `The model could not tie the imported rule “${rule.name}” to the source Word document.`,
          );
        }
        return { ...rule, standard, fallbacks, unacceptable, sourceRefs };
      }),
    })),
  };
}

function validateModel(model: string): void {
  if (!model.trim()) throw new Error("Select a model.");
  providerForModel(model.trim());
}

type ModelAvailability =
  | { available: true }
  | { available: false; reason: string };

function providerKeyName(
  provider:
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "vercel"
    | "opencode-go",
): keyof UserApiKeys {
  return provider;
}

function providerDisplayName(provider: keyof UserApiKeys): string {
  if (provider === "claude") return "Anthropic (Claude)";
  if (provider === "gemini") return "Google (Gemini)";
  if (provider === "kimi") return "Moonshot (Kimi)";
  if (provider === "openai") return "OpenAI";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "vercel") return "Vercel AI Gateway";
  if (provider === "opencode-go") return "OpenCode Go";
  return "CourtListener";
}

export function playbookModelAvailability(
  modelId: string,
  apiKeys: UserApiKeys,
  features: UserFeatures,
  stack: string[] = [],
): ModelAvailability {
  if (stack.includes(modelId)) {
    return {
      available: false,
      reason: `Model configuration contains a circular committee reference: ${[...stack, modelId].join(" -> ")}.`,
    };
  }

  const requiredFeature = featureForModel(modelId);
  if (requiredFeature && !features[requiredFeature]) {
    return {
      available: false,
      reason: `Model ${modelId} is disabled in Account > Features.`,
    };
  }

  const committee = getCommitteeModel(modelId);
  if (committee) {
    const members = committee.members.map((member) =>
      typeof member === "string" ? member : member.model,
    );
    for (const dependency of [...members, committee.chair]) {
      const availability = playbookModelAvailability(
        dependency,
        apiKeys,
        features,
        [...stack, modelId],
      );
      if (!availability.available) {
        return {
          available: false,
          reason: `Committee ${modelId} is unavailable because ${dependency} is unavailable. ${availability.reason}`,
        };
      }
    }
    return { available: true };
  }

  const configured = getConfiguredModel(modelId);
  if (configured?.provider === "openai-compatible") {
    const providerKey = configured.apiKeyProvider;
    if (providerKey && apiKeys[providerKey]?.trim()) return { available: true };
    if (apiKeyForConfiguredModel(configured)) return { available: true };
    if (!providerKey && !configured.apiKey && !configured.apiKeyEnv)
      return { available: true };
    const credential = providerKey
      ? `${providerDisplayName(providerKey)} API key`
      : configured.apiKeyEnv || "API key";
    return {
      available: false,
      reason: `${credential} is not configured for ${configured.label || configured.id}.`,
    };
  }

  let provider: ReturnType<typeof providerForModel>;
  try {
    provider = providerForModel(modelId);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (provider === "ollama") return { available: true };
  if (provider === "openai-compatible") {
    return {
      available: false,
      reason: `Model ${modelId} is not fully configured.`,
    };
  }
  const key = providerKeyName(provider);
  return apiKeys[key]?.trim()
    ? { available: true }
    : {
        available: false,
        reason: `${providerDisplayName(key)} API key is not configured.`,
      };
}

async function assertPlaybookModelAvailable(
  userId: string,
  model: string,
  db: Db,
): Promise<UserApiKeys> {
  const apiKeys = await getUserApiKeys(userId, db);
  const { data: profile } = await db
    .from("user_profiles")
    .select("feature_flags")
    .eq("user_id", userId)
    .maybeSingle();
  const availability = playbookModelAvailability(
    model,
    apiKeys,
    normalizeUserFeatures(profile?.feature_flags),
  );
  if (!availability.available) throw new Error(availability.reason);
  return apiKeys;
}

async function availablePlaybookModels(userId: string, db: Db) {
  const apiKeys = await getUserApiKeys(userId, db);
  const configuredModels = configuredModelSummaries();
  const { data: profile } = await db
    .from("user_profiles")
    .select("title_model, tabular_model, feature_flags")
    .eq("user_id", userId)
    .maybeSingle();
  const features = normalizeUserFeatures(profile?.feature_flags);
  const candidateIds = [
    ...new Set([
      ...builtInModelIds(),
      ...configuredModels.map((model) => model.id),
      ...(typeof profile?.title_model === "string"
        ? [profile.title_model]
        : []),
      ...(typeof profile?.tabular_model === "string"
        ? [profile.tabular_model]
        : []),
    ]),
  ];
  const availableModelIds = candidateIds.filter(
    (modelId) => playbookModelAvailability(modelId, apiKeys, features).available,
  );
  const preferred = [
    profile?.title_model,
    profile?.tabular_model,
    DEFAULT_MAIN_MODEL,
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .find((modelId) => availableModelIds.includes(modelId));
  return {
    apiKeys,
    configuredModels,
    availableModelIds,
    defaultModel: preferred || availableModelIds[0] || null,
  };
}

async function updateImportAttempt(
  db: Db,
  attemptId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("playbook_imports")
    .update({
      ...values,
      updated_at: new Date().toISOString(),
    })
    .eq("id", attemptId);
  if (error) throw error;
}

function importStageLabel(stage: PlaybookImportStage): string {
  return stage.replaceAll("_", " ");
}

export function playbookImportFailureMessage(
  stage: PlaybookImportStage,
  error: unknown,
  timeoutMs = playbookCompilationTimeoutMs(),
): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (
    (stage === "compiling" || stage === "repairing_output") &&
    (name === "TimeoutError" || /timed?\s*out|aborted due to timeout/i.test(message))
  ) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    return `The selected model did not finish within ${minutes} minute${minutes === 1 ? "" : "s"}. Try again or select another model.`;
  }
  return message;
}

export function playbookCompilationTimeoutMs(
  configured =
    process.env.PLAYBOOK_COMPILATION_TIMEOUT_MS?.trim() ||
    process.env.LLM_REQUEST_TIMEOUT_MS?.trim(),
): number {
  const value = Number(configured);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_PLAYBOOK_COMPILATION_TIMEOUT_MS;
}

function publicPlaybook(
  row: Record<string, unknown>,
  published: { versionNumber: number; name: string } | null,
): Playbook {
  const draft = stableIds(
    playbookContentSchema.parse(parseJson(row.draft_json)),
  );
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: row.status === "published" ? "published" : "draft",
    draft,
    publishedVersionId: row.published_version_id
      ? String(row.published_version_id)
      : null,
    publishedVersionNumber: published?.versionNumber ?? null,
    publishedName: published?.name ?? null,
    sourceFilename: row.source_filename ? String(row.source_filename) : null,
    importModel: row.import_model ? String(row.import_model) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function publishedVersionInfo(
  db: Db,
  versionId: unknown,
): Promise<{ versionNumber: number; name: string } | null> {
  if (!versionId) return null;
  const { data } = await db
    .from("playbook_versions")
    .select("version_number, content_json")
    .eq("id", String(versionId))
    .maybeSingle();
  if (!data) return null;
  const content = playbookContentSchema.parse(parseJson(data.content_json));
  return { versionNumber: Number(data.version_number), name: content.name };
}

export async function listPlaybooks(
  userId: string,
  db: Db = createServerDatabase(),
): Promise<Playbook[]> {
  ensurePlaybookSchema();
  const { data, error } = await db
    .from("playbooks")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return Promise.all(
    (data ?? []).map(async (row: Record<string, unknown>) =>
      publicPlaybook(
        row,
        await publishedVersionInfo(db, row.published_version_id),
      ),
    ),
  );
}

export async function getPlaybook(
  userId: string,
  id: string,
  db: Db = createServerDatabase(),
): Promise<Playbook> {
  ensurePlaybookSchema();
  const { data, error } = await db
    .from("playbooks")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Playbook not found.");
  return publicPlaybook(
    data,
    await publishedVersionInfo(db, data.published_version_id),
  );
}

function compilationPrompt(
  structure: PlaybookWordStructure,
  requestedName: string,
): string {
  return `Convert the supplied human-authored legal playbook into structured rules. Preserve concepts and sample clauses; do not invent policy. A source marker such as [P4] or [T2R3C1] identifies the exact paragraph or table cell. Every rule and sample clause must cite the relevant sourceRefs.

Rules may contain a standard position, fallback positions, unacceptable positions, guidance, conditions, and escalation actions. A position can be a concept or exact language. Mark sample clause usage as illustrative, preferred, verbatim, accepted, or unacceptable. Use verbatim only when the source clearly requires exact wording. If a clause must be present, set required true. Keep uncertain material in guidance rather than guessing.

The conditions field must always be an array of plain JSON strings, for example ["Applies when annual fees exceed $100,000"]. Never put objects, arrays, numbers, or booleans inside conditions. Express each condition as one readable sentence. Only actions may contain objects, and every action object must contain string fields named scenario and instruction.

Return JSON only with this shape:
{"name":"${requestedName.replace(/["\\]/g, "")}","description":"","globalGuidance":"","representedParty":"","documentTypes":[],"jurisdictions":[],"topics":[{"id":"topic-1","name":"","rules":[{"id":"topic-1-rule-1","name":"","concept":"","scope":"clause|agreement","required":false,"guidance":"","standard":{"name":"Standard","criteria":"","sampleClauses":[{"text":"","usage":"illustrative|preferred|verbatim|accepted|unacceptable","sourceRefs":["P1"]}]}|null,"fallbacks":[],"unacceptable":[],"conditions":[],"actions":[{"scenario":"","instruction":""}],"sourceRefs":["P1"]}]}]}

SOURCE PLAYBOOK:
${structure.text.slice(0, 150_000)}`;
}

function compilationRetryPrompt(
  structure: PlaybookWordStructure,
  requestedName: string,
  validationError: string,
): string {
  return `${compilationPrompt(structure, requestedName)}

RETRY REQUIREMENT:
The previous response could not be imported for this reason:
${validationError}

Recompile the source from the beginning. Start the response with { and end it with }. Return one complete JSON object only; do not include analysis, commentary, or Markdown fences.`;
}

export async function importPlaybookFromDocx(args: {
  userId: string;
  filename: string;
  buffer: Buffer;
  name?: string;
  model: string;
  db?: Db;
  dependencies?: {
    completeText?: typeof completeText;
  };
}): Promise<Playbook> {
  const db = args.db ?? createServerDatabase();
  ensurePlaybookSchema();
  const now = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const model = args.model.trim();
  const compilationTimeoutMs = playbookCompilationTimeoutMs();
  let stage: PlaybookImportStage = "validating_file";
  let uploadedStorageKey: string | null = null;
  const attempt = await db.from("playbook_imports").insert({
    id: attemptId,
    user_id: args.userId,
    filename: args.filename,
    requested_name: args.name?.trim() || null,
    model,
    status: "running",
    stage,
    error: null,
    playbook_id: null,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  });
  if (attempt.error) throw attempt.error;

  try {
    if (!args.filename.toLowerCase().endsWith(".docx"))
      throw new Error("Playbook import currently requires a .docx file.");
    if (!args.buffer.length) throw new Error("The uploaded playbook is empty.");

    stage = "checking_model";
    await updateImportAttempt(db, attemptId, { stage });
    validateModel(model);
    const apiKeys = await assertPlaybookModelAvailable(args.userId, model, db);

    stage = "extracting_word";
    await updateImportAttempt(db, attemptId, { stage });
    const structure = await extractPlaybookWordStructure(args.buffer);
    if (structure.text.length > 150_000) {
      throw new Error(
        "The Word playbook is too large to compile in one pass. Split it into smaller playbooks before importing.",
      );
    }
    const fallbackName =
      args.filename.replace(/\.docx$/i, "").trim() || "Imported playbook";
    const name = args.name?.trim() || fallbackName;

    stage = "compiling";
    await updateImportAttempt(db, attemptId, { stage });
    const runCompletion = args.dependencies?.completeText ?? completeText;
    const openRouterOutputControls = isOpenRouterModelId(model)
      ? {
          responseFormat: { type: "json_object" },
          plugins: [{ id: "response-healing" }],
        }
      : {};
    const raw = await runCompletion({
      model,
      systemPrompt:
        "You compile legal playbooks into auditable structured data. Return only valid JSON and never add legal positions absent from the source.",
      user: compilationPrompt(structure, name),
      maxTokens: 16_000,
      apiKeys,
      requestTimeoutMs: compilationTimeoutMs,
      ...openRouterOutputControls,
    });

    stage = "validating_output";
    await updateImportAttempt(db, attemptId, { stage });
    const content = await validatePlaybookCompilationWithRetry({
      raw,
      structure,
      retry: async (validationError) => {
        stage = "repairing_output";
        await updateImportAttempt(db, attemptId, { stage });
        const retried = await runCompletion({
          model,
          systemPrompt:
            "You compile legal playbooks into auditable structured data. Your previous response failed validation. Return exactly one complete valid JSON object and no other text.",
          user: compilationRetryPrompt(structure, name, validationError),
          maxTokens: 16_000,
          apiKeys,
          requestTimeoutMs: compilationTimeoutMs,
          ...openRouterOutputControls,
        });
        stage = "validating_output";
        await updateImportAttempt(db, attemptId, { stage });
        return retried;
      },
    });
    const id = crypto.randomUUID();
    const storageKey = `playbooks/${args.userId}/${id}/source.docx`;

    stage = "storing_source";
    await updateImportAttempt(db, attemptId, { stage });
    await uploadFile(
      storageKey,
      args.buffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    uploadedStorageKey = storageKey;

    stage = "saving_playbook";
    await updateImportAttempt(db, attemptId, { stage });
    const { error } = await db.from("playbooks").insert({
      id,
      user_id: args.userId,
      name: content.name,
      description: content.description,
      status: "draft",
      draft_json: content,
      published_version_id: null,
      source_filename: args.filename,
      source_storage_key: storageKey,
      source_structure_json: structure,
      import_model: model,
      created_at: now,
      updated_at: now,
    });
    if (error) {
      await deleteFile(storageKey).catch(() => {});
      uploadedStorageKey = null;
      throw error;
    }
    uploadedStorageKey = null;

    stage = "completed";
    const completedAt = new Date().toISOString();
    try {
      await updateImportAttempt(db, attemptId, {
        status: "completed",
        stage,
        playbook_id: id,
        completed_at: completedAt,
      });
    } catch (auditError) {
      console.error("[playbooks] failed to complete import audit record", {
        attemptId,
        playbookId: id,
        error:
          auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    return getPlaybook(args.userId, id, db);
  } catch (error) {
    const message = playbookImportFailureMessage(
      stage,
      error,
      compilationTimeoutMs,
    );
    const completedAt = new Date().toISOString();
    if (uploadedStorageKey) {
      await deleteFile(uploadedStorageKey).catch(() => {});
    }
    try {
      await updateImportAttempt(db, attemptId, {
        status: "failed",
        stage,
        error: message,
        completed_at: completedAt,
      });
    } catch (auditError) {
      console.error("[playbooks] failed to record import failure", {
        attemptId,
        error:
          auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    throw new PlaybookImportError(
      `Playbook import failed during ${importStageLabel(stage)}: ${message}`,
      attemptId,
      stage,
      { cause: error },
    );
  }
}

export async function updatePlaybookDraft(
  userId: string,
  id: string,
  raw: unknown,
  db: Db = createServerDatabase(),
): Promise<Playbook> {
  await getPlaybook(userId, id, db);
  const draft = stableIds(playbookContentSchema.parse(raw));
  const { error } = await db
    .from("playbooks")
    .update({
      name: draft.name,
      description: draft.description,
      draft_json: draft,
      status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
  return getPlaybook(userId, id, db);
}

export async function publishPlaybook(
  userId: string,
  id: string,
  db: Db = createServerDatabase(),
): Promise<Playbook> {
  const playbook = await getPlaybook(userId, id, db);
  const { data: versions, error: versionError } = await db
    .from("playbook_versions")
    .select("version_number")
    .eq("playbook_id", id)
    .order("version_number", { ascending: false })
    .limit(1);
  if (versionError) throw versionError;
  const next = Number(versions?.[0]?.version_number ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error } = await db.from("playbook_versions").insert({
    id: versionId,
    playbook_id: id,
    user_id: userId,
    version_number: next,
    content_json: playbook.draft,
    created_at: now,
  });
  if (error) throw error;
  const updated = await db
    .from("playbooks")
    .update({
      status: "published",
      published_version_id: versionId,
      updated_at: now,
    })
    .eq("id", id)
    .eq("user_id", userId);
  if (updated.error) {
    await db
      .from("playbook_versions")
      .delete()
      .eq("id", versionId)
      .eq("user_id", userId);
    throw updated.error;
  }
  return getPlaybook(userId, id, db);
}

async function publishedContent(
  userId: string,
  id: string,
  db: Db,
  requestedVersionId?: string,
): Promise<{
  playbook: Playbook;
  versionId: string;
  versionNumber: number;
  content: PlaybookContent;
}> {
  const playbook = await getPlaybook(userId, id, db);
  const versionId = requestedVersionId ?? playbook.publishedVersionId;
  if (!versionId)
    throw new Error("Publish the playbook before running a review.");
  const { data, error } = await db
    .from("playbook_versions")
    .select("content_json, version_number")
    .eq("id", versionId)
    .eq("playbook_id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("The published playbook version was not found.");
  return {
    playbook,
    versionId,
    versionNumber: Number(data.version_number),
    content: stableIds(
      playbookContentSchema.parse(parseJson(data.content_json)),
    ),
  };
}

export async function buildAssistantPlaybookContext(
  userId: string,
  id: string,
  db: Db = createServerDatabase(),
  versionId?: string,
): Promise<{
  prompt: string;
  selection: { id: string; title: string; version: number; versionId: string };
}> {
  const published = await publishedContent(userId, id, db, versionId);
  const { playbook, content } = published;
  const serialized = JSON.stringify(content);
  if (serialized.length > 100_000) {
    throw new Error(
      "The published playbook is too large to use in Assistant. Split it into smaller playbooks.",
    );
  }

  if (!published.versionNumber) {
    throw new Error("The published playbook version was not found.");
  }

  return {
    selection: {
      id: playbook.id,
      title: content.name,
      version: published.versionNumber,
      versionId: published.versionId,
    },
    prompt: `ACTIVE PUBLISHED PLAYBOOK:
The user selected "${content.name}" version ${published.versionNumber} for this turn. This playbook is already loaded below. A playbook is not a workflow: never call list_workflows or read_workflow to find, verify, or replace this active playbook. Treat the structured playbook below as the user's approved legal and commercial policy. Apply every relevant rule to the requested analysis or drafting task. Distinguish standard, fallback, and unacceptable positions; follow conditions and escalation actions; and use sample clauses according to their usage labels. Do not claim that a document complies when you lack enough document evidence. If the user's request conflicts with the playbook, identify the conflict rather than silently ignoring the playbook. Do not invent positions that are absent from it.

PUBLISHED PLAYBOOK JSON:
${serialized}`,
  };
}

function reviewPrompt(
  content: PlaybookContent,
  documentText: string,
  mode: "strict" | "permissive",
): string {
  return `Review the full contract against the published playbook. Apply unacceptable positions first. In strict mode, fallback matches still need review. In permissive mode, a fallback may be acceptable but explain which fallback applies. Flag a missing required rule as missing_required. Use not_applicable only when an optional concept is absent. Quote exact contract text so Word can locate it. suggestedText must be a complete replacement for quote, or the complete clause to insert for missing_required. Do not suggest an edit for acceptable or not_applicable findings. Do not invent contract language or findings.

Return JSON only:
{"summary":"","findings":[{"topicId":"topic-1|null","ruleId":"topic-1-rule-1|null","ruleName":"","status":"not_applicable|acceptable|needs_review|unacceptable|missing_required|outside_scope","quote":"exact contract text or empty when missing","location":"section or heading","analysis":"","suggestedText":""}]}

REVIEW MODE: ${mode}
PLAYBOOK:
${JSON.stringify(content).slice(0, 100_000)}

CONTRACT:
${documentText.slice(0, 180_000)}`;
}

type PlaybookPosition =
  PlaybookContent["topics"][number]["rules"][number]["fallbacks"][number];

function actualDocumentQuote(documentText: string, proposed: string): string {
  const quote = proposed.trim();
  if (!quote) return "";
  if (documentText.includes(quote)) return quote;
  const parts = quote.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const pattern = parts
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  try {
    return documentText.match(new RegExp(pattern, "i"))?.[0] ?? "";
  } catch {
    return "";
  }
}

function normalizeFindings(
  content: PlaybookContent,
  documentText: string,
  findings: z.infer<typeof findingSchema>[],
): PlaybookFinding[] {
  const rules = new Map<string, { topicId: string; name: string }>();
  for (const topic of content.topics) {
    for (const rule of topic.rules)
      rules.set(rule.id!, { topicId: topic.id!, name: rule.name });
  }
  const seen = new Set<string>();
  const normalized: PlaybookFinding[] = [];
  for (const finding of findings) {
    if (finding.status === "outside_scope") {
      normalized.push({
        ...finding,
        id: crypto.randomUUID(),
        topicId: null,
        ruleId: null,
        quote: actualDocumentQuote(documentText, finding.quote),
      });
      continue;
    }
    const rule = finding.ruleId ? rules.get(finding.ruleId) : null;
    if (!rule || !finding.ruleId || seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    normalized.push({
      ...finding,
      id: crypto.randomUUID(),
      topicId: rule.topicId,
      ruleId: finding.ruleId,
      ruleName: rule.name,
      quote: actualDocumentQuote(documentText, finding.quote),
    });
  }
  for (const [ruleId, rule] of rules) {
    if (seen.has(ruleId)) continue;
    normalized.push({
      id: crypto.randomUUID(),
      topicId: rule.topicId,
      ruleId,
      ruleName: rule.name,
      status: "needs_review",
      quote: "",
      location: "",
      suggestedText: "",
      analysis:
        "The model did not return a result for this published rule. Review it manually before completing the playbook review.",
    });
  }
  return normalized;
}

export async function reviewWithPlaybook(args: {
  userId: string;
  playbookId: string;
  documentText: string;
  documentName?: string;
  model: string;
  reviewMode: "strict" | "permissive";
  db?: Db;
}) {
  const db = args.db ?? createServerDatabase();
  validateModel(args.model);
  if (!args.documentText.trim()) throw new Error("Document text is required.");
  if (args.documentText.length > 180_000)
    throw new Error(
      "The document is too large for a complete playbook review. Review a shorter document or selected sections.",
    );
  const { versionId, content } = await publishedContent(
    args.userId,
    args.playbookId,
    db,
  );
  const apiKeys = await assertPlaybookModelAvailable(
    args.userId,
    args.model,
    db,
  );
  if (JSON.stringify(content).length > 100_000)
    throw new Error(
      "The published playbook is too large for a complete review. Split it into smaller playbooks.",
    );
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const row = {
    id: runId,
    playbook_id: args.playbookId,
    version_id: versionId,
    user_id: args.userId,
    model: args.model,
    document_name: args.documentName?.trim() || null,
    review_mode: args.reviewMode,
    status: "running",
    summary: null,
    findings_json: [],
    error: null,
    started_at: startedAt,
    completed_at: null,
    created_at: startedAt,
    updated_at: startedAt,
  };
  const inserted = await db.from("playbook_runs").insert(row);
  if (inserted.error) throw inserted.error;
  try {
    const raw = await completeText({
      model: args.model,
      systemPrompt:
        "You are a cautious contract review system. Apply only the supplied playbook and return auditable JSON.",
      user: reviewPrompt(content, args.documentText, args.reviewMode),
      maxTokens: 20_000,
      apiKeys,
    });
    const parsed = reviewSchema.parse(parseModelJson(raw));
    const findings = normalizeFindings(
      content,
      args.documentText,
      parsed.findings,
    );
    const completedAt = new Date().toISOString();
    const updated = await db
      .from("playbook_runs")
      .update({
        status: "completed",
        summary: parsed.summary,
        findings_json: findings,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq("id", runId)
      .eq("user_id", args.userId);
    if (updated.error) throw updated.error;
    return {
      id: runId,
      playbookId: args.playbookId,
      versionId,
      model: args.model,
      documentName: args.documentName ?? null,
      reviewMode: args.reviewMode,
      status: "completed" as const,
      summary: parsed.summary,
      findings,
      error: null,
      startedAt,
      completedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    await db
      .from("playbook_runs")
      .update({
        status: "failed",
        error: message,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq("id", runId)
      .eq("user_id", args.userId);
    throw error;
  }
}

export async function listPlaybookRuns(
  userId: string,
  playbookId: string,
  db: Db = createServerDatabase(),
) {
  await getPlaybook(userId, playbookId, db);
  const { data, error } = await db
    .from("playbook_runs")
    .select("*")
    .eq("playbook_id", playbookId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    playbookId: String(row.playbook_id),
    versionId: String(row.version_id),
    model: String(row.model),
    documentName: row.document_name ? String(row.document_name) : null,
    reviewMode: row.review_mode === "permissive" ? "permissive" : "strict",
    status: String(row.status),
    summary: row.summary ? String(row.summary) : null,
    findings: Array.isArray(row.findings_json)
      ? row.findings_json
      : (parseJson(row.findings_json) ?? []),
    error: row.error ? String(row.error) : null,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
}

export async function deletePlaybook(
  userId: string,
  id: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  ensurePlaybookSchema();
  const { data, error } = await db
    .from("playbooks")
    .select("source_storage_key")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Playbook not found.");
  await db
    .from("playbook_runs")
    .delete()
    .eq("playbook_id", id)
    .eq("user_id", userId);
  await db
    .from("playbook_versions")
    .delete()
    .eq("playbook_id", id)
    .eq("user_id", userId);
  await db.from("playbooks").delete().eq("id", id).eq("user_id", userId);
  if (data.source_storage_key)
    await deleteFile(String(data.source_storage_key)).catch(() => {});
}

export async function playbookConfiguration(
  userId: string,
  db: Db = createServerDatabase(),
) {
  ensurePlaybookSchema();
  const { configuredModels, availableModelIds, defaultModel } =
    await availablePlaybookModels(userId, db);
  return { configuredModels, availableModelIds, defaultModel };
}
