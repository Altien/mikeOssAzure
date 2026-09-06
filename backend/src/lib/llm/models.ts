import {
    REASONING_LEVELS,
    type Provider,
    type ReasoningLevel,
    type UserApiKeys,
} from "./types";
import {
    configuredModelIds,
    configuredProviderForModel,
    getCommitteeModel,
    getConfiguredModel,
} from "./registry";
import { hasEnvApiKey } from "../userApiKeys";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
] as const;
// Ollama models are detected dynamically (see GET /models/ollama). Any id of
// the form "ollama/<tag>" is valid — see providerForModel / resolveModel.

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MID_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MID_MODELS = ["gpt-5.6-terra", "gpt-5.4"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.6-luna", "gpt-5.4-mini"] as const;

// There is deliberately NO hardcoded default model here (neither main,
// title, nor tabular). A silent fallback runs the risk of attributing a
// reply to — and billing — a provider the user never chose (this bit a
// deployment whose stale composer selection quietly ran Gemini against an
// exhausted spend cap). Callers resolve from what is actually usable:
// saved router selections first, then registry/built-in models with keys
// (see userSettings.resolveTierFallback and streaming's pickDefaultModel),
// and fail loudly when nothing is configured.

const STANDARD_REASONING_LEVELS: readonly ReasoningLevel[] =
    REASONING_LEVELS.filter((level) => level !== "max");
const GPT_56_REASONING_LEVELS: readonly ReasoningLevel[] = REASONING_LEVELS;

/** Explicit AI SDK reasoning levels supported by the selected model family. */
export function reasoningLevelsForModel(
    model: string,
): readonly ReasoningLevel[] {
    const catalogId = model.replace(/^(?:openrouter|vercel)\//, "");
    if (/(?:^|\/)gpt-5\.6(?:-|$)/.test(catalogId)) {
        return GPT_56_REASONING_LEVELS;
    }
    return STANDARD_REASONING_LEVELS;
}

/** Move a stale saved level to the nearest level supported by the model. */
export function normalizeReasoningLevelForModel(
    model: string,
    reasoning: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
    if (!reasoning) return undefined;
    const supported = reasoningLevelsForModel(model);
    if (supported.includes(reasoning)) return reasoning;
    const requestedIndex = REASONING_LEVELS.indexOf(reasoning);
    return supported.reduce((nearest, candidate) => {
        const nearestDistance = Math.abs(
            REASONING_LEVELS.indexOf(nearest) - requestedIndex,
        );
        const candidateDistance = Math.abs(
            REASONING_LEVELS.indexOf(candidate) - requestedIndex,
        );
        return candidateDistance <= nearestDistance ? candidate : nearest;
    }, supported[0] ?? "high");
}

// OpenCode Go publishes one catalog across three incompatible wire protocols:
// OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions. The live
// /models payload does not identify a model's protocol, so keep these lists
// fail-closed and in sync with https://opencode.ai/docs/go/#endpoints. A new
// catalog entry is not offered until Mike can actually speak its protocol.
export const OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS: ReadonlySet<string> =
    new Set([
        "glm-5",
        "glm-5.1",
        "glm-5.2",
        "glm-5.3",
        "kimi-k2.6",
        "kimi-k2.7-code",
        "kimi-k3",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "hy3",
    ]);

export const OPENCODE_GO_MESSAGES_MODEL_IDS: ReadonlySet<string> = new Set([
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
]);

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

export function builtInModelIds(): string[] {
    return [...ALL_MODELS];
}

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    const configured = configuredProviderForModel(model);
    if (configured) return configured;
    if (model.startsWith("ollama")) return "ollama";
    if (model.startsWith("openrouter/")) return "openrouter";
    if (model.startsWith("vercel/")) return "vercel";
    if (model.startsWith("opencode-go/")) return "opencode-go";
    if (model.startsWith("synthetic/")) return "synthetic";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

// Conservative context-window defaults (tokens) by provider family. Used to
// decide when an attached playbook document is large enough to warrant
// chunked analysis passes. Configured models can override via `contextWindow`.
const PROVIDER_CONTEXT_WINDOW_DEFAULTS: Partial<Record<Provider, number>> = {
    claude: 200_000,
    gemini: 1_000_000,
    openai: 400_000,
    ollama: 131_072,
};

export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 131_072;

export function modelContextWindowTokens(model: string): number {
    const configured = getConfiguredModel(model);
    if (configured?.contextWindow && configured.contextWindow > 0) {
        return configured.contextWindow;
    }
    try {
        const provider = providerForModel(model);
        return (
            PROVIDER_CONTEXT_WINDOW_DEFAULTS[provider] ??
            DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
        );
    } catch {
        return DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
    }
}

// Renamed/retired static ids → their current equivalents. Stored preferences
// and localStorage selections outlive catalog renames; mapping here keeps an
// old saved value working instead of silently kicking it to the fallback.
export const LEGACY_MODEL_IDS: Record<string, string> = {
    "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
    "gpt-5.4-lite": "gpt-5.4-mini",
};

export function resolveModel(
    id: string | null | undefined,
    fallback: string,
): string {
    const canonical = id ? (LEGACY_MODEL_IDS[id] ?? id) : id;
    if (canonical && getConfiguredModel(canonical)) return canonical;
    if (
        canonical &&
        (ALL_MODELS.has(canonical) ||
            canonical.startsWith("ollama/") ||
            /^(?:openrouter|vercel)\/[^\s/]+\/[^\s]+$/.test(canonical) ||
            // OpenCode Go's catalog ids are single-segment ("glm-5"), not the
            // vendor/model pairs OpenRouter and Vercel publish. Synthetic ids
            // carry their own family prefixes ("hf:zai-org/GLM-5.2",
            // "syn:large:text"), so accept any single namespaced segment.
            /^(?:opencode-go|synthetic)\/[^\s]+$/.test(canonical))
    )
        return canonical;
    return fallback;
}

export function openRouterModelId(model: string): string {
    return model.replace(/^openrouter\//, "");
}

export function vercelModelId(model: string): string {
    return model.replace(/^vercel\//, "");
}

export function openCodeGoModelId(model: string): string {
    return model.replace(/^opencode-go\//, "");
}

export function syntheticModelId(model: string): string {
    return model.replace(/^synthetic\//, "");
}

export function isOpenCodeGoChatCompletionsModel(model: string): boolean {
    return OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS.has(
        openCodeGoModelId(model),
    );
}

export function isOpenCodeGoMessagesModel(model: string): boolean {
    return OPENCODE_GO_MESSAGES_MODEL_IDS.has(openCodeGoModelId(model));
}

export function isSupportedOpenCodeGoModel(model: string): boolean {
    return (
        isOpenCodeGoChatCompletionsModel(model) ||
        isOpenCodeGoMessagesModel(model)
    );
}

// ---------------------------------------------------------------------------
// Usable-model resolution (API key awareness)
// ---------------------------------------------------------------------------

function providerKeyAvailable(
    provider: Provider,
    apiKeys?: UserApiKeys,
): boolean {
    switch (provider) {
        case "claude":
            return !!apiKeys?.claude?.trim() || hasEnvApiKey("claude");
        case "gemini":
            return !!apiKeys?.gemini?.trim() || hasEnvApiKey("gemini");
        case "openai":
            return !!apiKeys?.openai?.trim() || hasEnvApiKey("openai");
        case "openrouter":
            return !!apiKeys?.openrouter?.trim() || hasEnvApiKey("openrouter");
        case "vercel":
            return !!apiKeys?.vercel?.trim() || hasEnvApiKey("vercel");
        case "synthetic":
            return !!apiKeys?.synthetic?.trim() || hasEnvApiKey("synthetic");
        case "ollama":
            return true;
        default:
            return false;
    }
}

/** True when the given model has any usable API key (user key or env). */
export function modelHasApiKey(
    model: string,
    apiKeys?: UserApiKeys,
): boolean {
    const configured = getConfiguredModel(model);
    if (configured) {
        if (configured.apiKey?.trim()) return true;
        const userKey = configured.apiKeyProvider
            ? apiKeys?.[configured.apiKeyProvider]?.trim()
            : undefined;
        if (userKey) return true;
        // A configured openai-compatible model with no key source at all
        // (e.g. a local server) requires no API key.
        if (!configured.apiKeyProvider && !configured.apiKeyEnv) return true;
        return configured.apiKeyEnv
            ? !!process.env[configured.apiKeyEnv]?.trim()
            : false;
    }
    if (getCommitteeModel(model)) {
        // Committee key resolution happens per-member at call time; don't
        // second-guess it here.
        return true;
    }
    try {
        return providerKeyAvailable(providerForModel(model), apiKeys);
    } catch {
        return false;
    }
}

/**
 * Like resolveModel, but when the resolved model has no usable API key,
 * substitute the first model that does (registry models first, then
 * built-ins). Returns the original resolution when nothing is configured so
 * the provider's own "key not configured" error still surfaces.
 */
export function resolveUsableModel(
    id: string | null | undefined,
    fallback: string,
    apiKeys?: UserApiKeys,
): string {
    const selected = resolveModel(id, fallback);
    if (modelHasApiKey(selected, apiKeys)) return selected;
    for (const candidate of configuredModelIds()) {
        if (candidate !== selected && modelHasApiKey(candidate, apiKeys)) {
            return candidate;
        }
    }
    for (const candidate of ALL_MODELS) {
        if (candidate !== selected && modelHasApiKey(candidate, apiKeys)) {
            return candidate;
        }
    }
    return selected;
}
