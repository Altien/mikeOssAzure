import { SETTINGS_MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "kimi"
    | "azureOpenai";

// MikeOssAzure providers are available when the backend reports an
// organisation credential through `globalApiKeys` (booleans only — actual
// values never reach the client). The personal fields remain in the type for
// compatibility with upstream Mike, which supports user-supplied keys.
//
// Azure OpenAI is a special case: availability is per-deployment rather
// than per-provider. The dropdown only shows deployments that came back
// from discovery, so an AOAI entry being in the rendered list already
// implies it's reachable. `globalApiKeys.azureOpenai` is retained only
// for the settings-page help text.
export type ApiKeyAvailability = {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey: string | null;
    globalApiKeys?: {
        claude: boolean;
        gemini: boolean;
        openai: boolean;
        kimi: boolean;
        azureOpenai: boolean;
    };
};

export function getModelProvider(
    modelId: string,
    extraModels?: ModelOption[],
): ModelProvider | null {
    // AOAI deployments are discovered dynamically and arrive via
    // `extraModels` rather than the static model list. The id-prefix
    // shortcut keeps callers that only have the id (no model record)
    // working. Static lookup uses SETTINGS_MODELS (upstream 44e868e) so
    // low-tier ids resolve too; dev's extraModels handling is kept.
    if (modelId.startsWith("aoai:")) return "azureOpenai";
    const model =
        SETTINGS_MODELS.find((m) => m.id === modelId) ??
        extraModels?.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "Anthropic") return "claude";
    if (model.group === "Google") return "gemini";
    if (model.group === "OpenAI") return "openai";
    if (model.group === "Kimi") return "kimi";
    if (model.group === "Azure OpenAI") return "azureOpenai";
    return null;
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyAvailability,
    extraModels?: ModelOption[],
): boolean {
    const provider = getModelProvider(modelId, extraModels);
    if (!provider) return false;
    if (provider === "azureOpenai") {
        // AOAI availability is per-deployment: the deployment is
        // available iff it appears in the dynamically-discovered list.
        return !!extraModels?.some((m) => m.id === modelId);
    }
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyAvailability,
): boolean {
    if (provider === "claude") {
        return (
            !!apiKeys.claudeApiKey?.trim() || !!apiKeys.globalApiKeys?.claude
        );
    }
    if (provider === "gemini") {
        return (
            !!apiKeys.geminiApiKey?.trim() || !!apiKeys.globalApiKeys?.gemini
        );
    }
    if (provider === "openai") {
        return (
            !!apiKeys.openaiApiKey?.trim() || !!apiKeys.globalApiKeys?.openai
        );
    }
    if (provider === "kimi") {
        return !!apiKeys.globalApiKeys?.kimi;
    }
    // azureOpenai availability is per-deployment, decided in
    // isModelAvailable via the discovered list. This branch is retained
    // for callers that only know the provider name; it can't tell
    // whether any specific deployment exists, so it errs on the side of
    // "the provider is reachable" if the env-global is configured.
    return !!apiKeys.globalApiKeys?.azureOpenai;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "gemini") return "Google (Gemini)";
    if (provider === "openai") return "OpenAI";
    if (provider === "kimi") return "Kimi K3";
    return "Azure OpenAI";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "Google") return "gemini";
    if (group === "OpenAI") return "openai";
    if (group === "Kimi") return "kimi";
    return "azureOpenai";
}
