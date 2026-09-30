import {
    completeOpenAICompatibleText,
    streamOpenAICompatible,
    type OpenAICompatibleAdapterConfig,
    type OpenAICompatibleCompleteParams,
} from "./openai_c";
import type { StreamChatParams, StreamChatResult } from "./types";

const KIMI_CONFIG: OpenAICompatibleAdapterConfig = {
    providerLabel: "Kimi K3",
    secretName: "moonshot-api-key",
    baseURL: "https://api.moonshot.ai/v1",
    apiKeyOverride: (apiKeys) => apiKeys?.kimi,
    logPrefix: "kimi",
    preserveReasoning: true,
};

export function streamKimi(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    return streamOpenAICompatible(params, KIMI_CONFIG);
}

export function completeKimiText(
    params: OpenAICompatibleCompleteParams,
): Promise<string> {
    // Moonshot's reasoning_effort has no "none"; "low" is its floor.
    const reasoningEffort =
        params.reasoningEffort === "none" ? "low" : params.reasoningEffort;
    return completeOpenAICompatibleText(
        { ...params, reasoningEffort },
        KIMI_CONFIG,
    );
}
