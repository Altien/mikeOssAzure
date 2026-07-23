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
    return completeOpenAICompatibleText(params, KIMI_CONFIG);
}
