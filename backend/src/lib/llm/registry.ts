import type { CommitteeModel, ConfiguredModel, Provider } from "./types";

type ModelRegistryConfig = {
  models?: ConfiguredModel[];
  committees?: CommitteeModel[];
};

const DEFAULT_CONFIG: ModelRegistryConfig = {
  models: [],
  committees: [],
};

let cached: ModelRegistryConfig | undefined;

export function loadModelRegistry(): ModelRegistryConfig {
  if (cached) return cached;
  const defaultModels = defaultConfiguredModels();
  const raw = process.env.MIKE_MODEL_CONFIG_JSON?.trim();
  if (!raw) {
    cached = { ...DEFAULT_CONFIG, models: defaultModels };
    return cached;
  }

  try {
    const parsed = JSON.parse(raw) as ModelRegistryConfig;
    cached = {
      models: mergeConfiguredModels(
        defaultModels,
        Array.isArray(parsed.models)
          ? parsed.models.filter(isConfiguredModel)
          : [],
      ),
      committees: Array.isArray(parsed.committees)
        ? parsed.committees.filter(isCommitteeModel)
        : [],
    };
  } catch (error) {
    throw new Error(
      `MIKE_MODEL_CONFIG_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return cached;
}

function defaultConfiguredModels(): ConfiguredModel[] {
  return [
    {
      id: "kimi-k3",
      label: "Kimi K3",
      provider: "openai-compatible",
      location: "cloud",
      apiModel: "k3",
      baseUrl: "https://api.kimi.com/coding/v1",
      apiKeyEnv: "KIMI_API_KEY",
      apiKeyProvider: "kimi",
      extraBody: { reasoning_effort: "high" },
    },
    {
      id: "kimi-k3-256k",
      label: "Kimi K3 256K",
      provider: "openai-compatible",
      location: "cloud",
      apiModel: "k3-256k",
      baseUrl: "https://api.kimi.com/coding/v1",
      apiKeyEnv: "KIMI_API_KEY",
      apiKeyProvider: "kimi",
      extraBody: { reasoning_effort: "high" },
    },
    {
      id: "qwen3.8-local",
      label: "Qwen 3.8 Guilfoyle (local)",
      provider: "openai-compatible",
      location: "local",
      // Guilfoyle now advertises the served model as `qwen38`.
      apiModel: "qwen38",
      baseUrl: "http://192.168.9.142:9091/v1",
      apiKeyEnv: "GUILFOYLE_DIRK_API_KEY",
      // Guilfoyle serves n_ctx=208384 on port 9091; chunk attached playbook docs
      // once they approach that window (see modelContextWindowTokens).
      contextWindow: 208_384,
      // Guilfoyle must be launched with automatic tool choice and the Qwen
      // parser (`--enable-auto-tool-choice --tool-call-parser qwen3`).
      // Qwen's reasoning mode can consume the entire local generation budget
      // on large document reviews before producing visible content.
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      playbookChunking: true,
    },
  ];
}

function mergeConfiguredModels(
  defaults: ConfiguredModel[],
  configured: ConfiguredModel[],
): ConfiguredModel[] {
  const byId = new Map<string, ConfiguredModel>();
  for (const model of defaults) byId.set(model.id, model);
  for (const model of configured) byId.set(model.id, model);
  return [...byId.values()];
}

export function getConfiguredModel(id: string): ConfiguredModel | null {
  const configured =
    loadModelRegistry().models?.find((model) => model.id === id) ?? null;
  if (configured) return configured;
  // "openrouter/…", "vercel/…" and "opencode-go/…" ids are NOT registry
  // models: they route through the first-class router providers, which
  // additionally gate on the user's saved router selection (see
  // lib/routerModels.ts). OpenCode Go used to be synthesized here as an
  // openai-compatible model; it now has native support in llm/providers.ts,
  // which also speaks its Messages protocol.
  return null;
}

export function getCommitteeModel(id: string): CommitteeModel | null {
  return (
    loadModelRegistry().committees?.find((committee) => committee.id === id) ??
    null
  );
}

export function configuredModelIds(): string[] {
  const registry = loadModelRegistry();
  return [
    ...(registry.models ?? []).map((model) => model.id),
    ...(registry.committees ?? []).map((committee) => committee.id),
  ];
}

export function configuredModelSummaries(): {
  id: string;
  label: string;
  provider: Provider | "committee";
  location: "cloud" | "local" | "committee";
}[] {
  const registry = loadModelRegistry();
  return [
    ...(registry.models ?? []).map((model) => ({
      id: model.id,
      label: model.label || model.id,
      provider: model.provider,
      location: model.location,
    })),
    ...(registry.committees ?? []).map((committee) => ({
      id: committee.id,
      label: committee.label || committee.id,
      provider: "committee" as const,
      location: "committee" as const,
    })),
  ];
}

export function configuredProviderForModel(id: string): Provider | null {
  const model = getConfiguredModel(id);
  if (model) return model.provider;
  if (getCommitteeModel(id)) return "openai-compatible";
  return null;
}

export function apiKeyForConfiguredModel(model: ConfiguredModel): string | null {
  if (model.apiKey?.trim()) return model.apiKey.trim();
  if (model.apiKeyEnv?.trim()) {
    return process.env[model.apiKeyEnv.trim()]?.trim() || null;
  }
  return null;
}

function isConfiguredModel(value: unknown): value is ConfiguredModel {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    isProvider(record.provider) &&
    (record.location === "cloud" || record.location === "local")
  );
}

function isProvider(value: unknown): value is Provider {
  return (
    value === "claude" ||
    value === "gemini" ||
    value === "openai" ||
    value === "openai-compatible"
  );
}

function isCommitteeModel(value: unknown): value is CommitteeModel {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    Array.isArray(record.members) &&
    record.members.every(
      (member) =>
        typeof member === "string" ||
        (!!member &&
          typeof member === "object" &&
          typeof (member as Record<string, unknown>).model === "string"),
    ) &&
    typeof record.chair === "string"
  );
}
