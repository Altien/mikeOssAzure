import {
    SETTINGS_MODELS,
    type ModelOption,
} from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

export type ModelProvider =
    | "claude"
    | "kimi"
    | "gemini"
    | "openai"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "local"
    | "committee"
    | "ollama";

export function getModelProvider(modelId: string): ModelProvider | null {
    if (modelId.startsWith("openrouter/")) return "openrouter";
    if (modelId.startsWith("vercel/")) return "vercel";
    if (modelId.startsWith("opencode-go/")) return "opencode-go";
    if (modelId.startsWith("ollama/")) return "ollama"; // dynamic, not in the static list
    const model = SETTINGS_MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return true;
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    if (
        provider === "local" ||
        provider === "committee" ||
        provider === "ollama"
    ) {
        return true;
    }
    return !!apiKeys[provider]?.configured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "local") return "Local";
    if (provider === "committee") return "Committee";
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "kimi") return "Moonshot (Kimi)";
    if (provider === "openai") return "OpenAI";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "vercel") return "Vercel AI Gateway";
    if (provider === "ollama") return "Local (Ollama)";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Local") return "local";
    if (group === "Committee") return "committee";
    if (group === "Anthropic") return "claude";
    if (group === "Moonshot") return "kimi";
    if (group === "OpenAI") return "openai";
    if (group === "OpenRouter") return "openrouter";
    if (group === "OpenCode Go") return "opencode-go";
    if (group === "Vercel AI Gateway") return "vercel";
    return "gemini";
}
