import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createServerDatabase,
  databaseProviderIsSQLite,
  type ServerDatabase,
} from "./database";
import { getSqliteDb } from "./sqlite";

type Db = ServerDatabase;

export type PromptLibraryItem = {
  id: string;
  userId: string | null;
  source: "built_in" | "user";
  name: string;
  prompt: string;
  description: string | null;
  promptType: string | null;
  categories: string[];
  practiceAreas: string[];
  sourceRequirements: string[];
  originalCreator: string | null;
  originalCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PromptLibraryInput = {
  name: string;
  prompt: string;
  description?: string | null;
  promptType?: string | null;
  categories?: string[];
  practiceAreas?: string[];
  sourceRequirements?: string[];
};

type PromptRow = {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  description: string | null;
  prompt_type: string | null;
  categories: string[] | string | null;
  practice_areas: string[] | string | null;
  source_requirements: string[] | string | null;
  created_at: string;
  updated_at: string;
};

type MikePrompt = {
  id: string;
  name: string;
  prompt: string;
  promptType: string | null;
  categories: string[];
  practiceAreas: string[];
  sourceRequirements: string[];
  originalCreator: string | null;
  originalCreatedAt: string | null;
};

const BUILTIN_IMPORTED_AT = "2026-07-29T18:14:42.184Z";
const PRIVATE_PROMPT_FILENAME = "mikeExamplePrompts.json";

function isMikePrompt(value: unknown): value is MikePrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.prompt === "string" &&
    (item.promptType === null || typeof item.promptType === "string") &&
    Array.isArray(item.categories) &&
    item.categories.every((entry) => typeof entry === "string") &&
    Array.isArray(item.practiceAreas) &&
    item.practiceAreas.every((entry) => typeof entry === "string") &&
    Array.isArray(item.sourceRequirements) &&
    item.sourceRequirements.every((entry) => typeof entry === "string") &&
    (item.originalCreator === null ||
      typeof item.originalCreator === "string") &&
    (item.originalCreatedAt === null ||
      typeof item.originalCreatedAt === "string")
  );
}

function privatePromptPaths(): string[] {
  const configured = process.env.MIKE_BUILTIN_PROMPTS_PATH?.trim();
  if (configured) return [path.resolve(configured)];
  return [
    path.resolve(process.cwd(), "data", PRIVATE_PROMPT_FILENAME),
    path.resolve(process.cwd(), "backend", "data", PRIVATE_PROMPT_FILENAME),
  ];
}

function loadPrivatePrompts(): MikePrompt[] {
  for (const filePath of privatePromptPaths()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn("[prompt-library] private prompt data must be an array", {
          filePath,
        });
        return [];
      }
      const prompts = parsed.filter(isMikePrompt);
      if (prompts.length !== parsed.length) {
        console.warn("[prompt-library] ignored invalid private prompt rows", {
          filePath,
          ignored: parsed.length - prompts.length,
        });
      }
      return prompts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      console.warn("[prompt-library] could not load private prompt data", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
  return [];
}

const builtIns: PromptLibraryItem[] = loadPrivatePrompts().map(
  (item) => ({
    id: item.id,
    userId: null,
    source: "built_in",
    name: item.name,
    prompt: item.prompt,
    description: null,
    promptType: item.promptType,
    categories: item.categories,
    practiceAreas: item.practiceAreas,
    sourceRequirements: item.sourceRequirements,
    originalCreator: item.originalCreator,
    originalCreatedAt: item.originalCreatedAt,
    createdAt: BUILTIN_IMPORTED_AT,
    updatedAt: BUILTIN_IMPORTED_AT,
  }),
);
const builtInsById = new Map(builtIns.map((item) => [item.id, item]));

export class PromptNotFoundError extends Error {}
export class BuiltInPromptMutationError extends Error {}

export function ensurePromptLibrarySchema(): void {
  if (!databaseProviderIsSQLite()) return;
  getSqliteDb().exec(`
      create table if not exists saved_prompts (
        id text primary key,
        user_id text not null,
        name text not null,
        prompt text not null,
        description text,
        prompt_type text,
        categories text not null default '[]',
        practice_areas text not null default '[]',
        source_requirements text not null default '[]',
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_saved_prompts_user_updated
        on saved_prompts(user_id, updated_at desc);
    `);
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function publicRow(row: PromptRow): PromptLibraryItem {
  return {
    id: row.id,
    userId: row.user_id,
    source: "user",
    name: row.name,
    prompt: row.prompt,
    description: row.description,
    promptType: row.prompt_type,
    categories: parseArray(row.categories),
    practiceAreas: parseArray(row.practice_areas),
    sourceRequirements: parseArray(row.source_requirements),
    originalCreator: null,
    originalCreatedAt: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanList(value: unknown, field: string, maxItems: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const values = value.map((item) => {
    if (typeof item !== "string")
      throw new Error(`${field} entries must be text.`);
    const text = item.trim();
    if (!text || text.length > 120)
      throw new Error(`${field} entries must be between 1 and 120 characters.`);
    return text;
  });
  if (values.length > maxItems)
    throw new Error(`${field} may contain at most ${maxItems} entries.`);
  return [...new Set(values)];
}

function validateInput(
  input: PromptLibraryInput,
): Required<PromptLibraryInput> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const description =
    typeof input.description === "string"
      ? input.description.trim() || null
      : null;
  const promptType =
    typeof input.promptType === "string"
      ? input.promptType.trim() || null
      : null;
  if (!name || name.length > 160)
    throw new Error("Name is required and must be 160 characters or fewer.");
  if (!prompt || prompt.length > 20_000)
    throw new Error(
      "Prompt is required and must be 20,000 characters or fewer.",
    );
  if (description && description.length > 1_000)
    throw new Error("Description must be 1,000 characters or fewer.");
  if (promptType && promptType.length > 80)
    throw new Error("Prompt type must be 80 characters or fewer.");
  return {
    name,
    prompt,
    description,
    promptType,
    categories: cleanList(input.categories, "Categories", 20),
    practiceAreas: cleanList(input.practiceAreas, "Practice areas", 30),
    sourceRequirements: cleanList(
      input.sourceRequirements,
      "Source requirements",
      10,
    ),
  };
}

export function listBuiltInPrompts(): PromptLibraryItem[] {
  return builtIns.map((item) => ({
    ...item,
    categories: [...item.categories],
    practiceAreas: [...item.practiceAreas],
    sourceRequirements: [...item.sourceRequirements],
  }));
}

export async function listPromptLibrary(
  userId: string,
  db: Db = createServerDatabase(),
): Promise<PromptLibraryItem[]> {
  ensurePromptLibrarySchema();
  const { data, error } = await db
    .from("saved_prompts")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return [
    ...((data ?? []) as PromptRow[]).map(publicRow),
    ...listBuiltInPrompts(),
  ];
}

export async function getPromptLibraryItem(
  userId: string,
  promptId: string,
  db: Db = createServerDatabase(),
): Promise<PromptLibraryItem> {
  const builtIn = builtInsById.get(promptId);
  if (builtIn)
    return {
      ...builtIn,
      categories: [...builtIn.categories],
      practiceAreas: [...builtIn.practiceAreas],
      sourceRequirements: [...builtIn.sourceRequirements],
    };
  ensurePromptLibrarySchema();
  const { data, error } = await db
    .from("saved_prompts")
    .select("*")
    .eq("id", promptId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PromptNotFoundError("Prompt not found.");
  return publicRow(data as PromptRow);
}

export async function createPromptLibraryItem(
  userId: string,
  rawInput: PromptLibraryInput,
  db: Db = createServerDatabase(),
): Promise<PromptLibraryItem> {
  ensurePromptLibrarySchema();
  const input = validateInput(rawInput);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const { error } = await db.from("saved_prompts").insert({
    id,
    user_id: userId,
    name: input.name,
    prompt: input.prompt,
    description: input.description,
    prompt_type: input.promptType,
    categories: input.categories,
    practice_areas: input.practiceAreas,
    source_requirements: input.sourceRequirements,
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;
  return getPromptLibraryItem(userId, id, db);
}

export async function updatePromptLibraryItem(
  userId: string,
  promptId: string,
  rawInput: PromptLibraryInput,
  db: Db = createServerDatabase(),
): Promise<PromptLibraryItem> {
  if (builtInsById.has(promptId))
    throw new BuiltInPromptMutationError("Built-in prompts cannot be edited.");
  await getPromptLibraryItem(userId, promptId, db);
  const input = validateInput(rawInput);
  const { error } = await db
    .from("saved_prompts")
    .update({
      name: input.name,
      prompt: input.prompt,
      description: input.description,
      prompt_type: input.promptType,
      categories: input.categories,
      practice_areas: input.practiceAreas,
      source_requirements: input.sourceRequirements,
      updated_at: new Date().toISOString(),
    })
    .eq("id", promptId)
    .eq("user_id", userId);
  if (error) throw error;
  return getPromptLibraryItem(userId, promptId, db);
}

export async function deletePromptLibraryItem(
  userId: string,
  promptId: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  if (builtInsById.has(promptId))
    throw new BuiltInPromptMutationError("Built-in prompts cannot be deleted.");
  await getPromptLibraryItem(userId, promptId, db);
  const { error } = await db
    .from("saved_prompts")
    .delete()
    .eq("id", promptId)
    .eq("user_id", userId);
  if (error) throw error;
}
