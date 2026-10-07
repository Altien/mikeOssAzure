import {
    SETTINGS_MODELS,
    canonicalModelId,
    type ModelOption,
} from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

// Upstream divergence (OSS-6, §2.3 item 3 — AOAI and org Key Vault keys):
// dev adds the "kimi" and "azureOpenai" providers. Availability still reads
// upstream's ApiKeyState; dev's backend reports organisation (Key Vault/env)
// credentials there with source "env" (backend routes/user.ts `/profile`
// apiKeyStatus). Azure OpenAI availability is per-deployment:
// `aoai:<deployment>` ids come from discovery
// (src/altien/models/aoaiDeployments.tsx) and arrive via
// `extraModels`. The "ollama" branches are upstream's, unreachable in dev
// (sync-log: fe942475).
export type ModelProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "mistral"
    | "openrouter"
    | "vercel"
    | "ollama"
    | "opencode-go"
    | "kimi"
    | "azureOpenai";

export function getModelProvider(
    modelId: string,
    extraModels?: readonly ModelOption[],
): ModelProvider | null {
    if (modelId.startsWith("ollama/")) return "ollama"; // dynamic, not in the static list
    if (modelId.startsWith("openrouter/")) return "openrouter";
    if (modelId.startsWith("vercel/")) return "vercel";
    if (modelId.startsWith("opencode-go/")) return "opencode-go";
    if (modelId.startsWith("aoai:")) return "azureOpenai"; // dynamic (dev)
    const model =
        SETTINGS_MODELS.find((m) => m.id === canonicalModelId(modelId)) ??
        extraModels?.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
    discoveredModels?: readonly ModelOption[] | readonly string[],
): boolean {
    // Registry IDs arrive as strings; Azure discovery supplies model options.
    // Both lists are authenticated server results, and the backend remains
    // authoritative when a credential or deployment changes.
    const configuredIds = discoveredModels &&
        (discoveredModels.length === 0 || typeof discoveredModels[0] === "string")
        ? discoveredModels as readonly string[] : [];
    if (configuredIds.includes(modelId)) return true;
    const extraModels = discoveredModels && discoveredModels.length > 0 &&
        typeof discoveredModels[0] !== "string"
        ? discoveredModels as readonly ModelOption[] : undefined;
    const provider = getModelProvider(modelId, extraModels);
    if (!provider) return false;
    if (provider === "azureOpenai" && extraModels) {
        // A deployment is available iff discovery returned it. Callers
        // without the discovered list fall back to the provider check.
        return extraModels.some((m) => m.id === modelId);
    }
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    if (provider === "ollama") return true; // local, no key needed
    if (provider === "azureOpenai") return !!apiKeys.azure_openai?.configured;
    return !!apiKeys[provider]?.configured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "mistral") return "Mistral AI";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "vercel") return "Vercel AI Gateway";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "ollama") return "Local (Ollama)";
    if (provider === "kimi") return "Kimi K3";
    if (provider === "azureOpenai") return "Azure OpenAI";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    if (group === "Mistral AI") return "mistral";
    if (group === "OpenRouter") return "openrouter";
    if (group === "Vercel AI Gateway") return "vercel";
    if (group === "OpenCode Go") return "opencode-go";
    if (group === "Local") return "ollama";
    if (group === "Kimi") return "kimi";
    if (group === "Azure OpenAI") return "azureOpenai";
    return "gemini";
}
