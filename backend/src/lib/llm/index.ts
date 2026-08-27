import { completeWithProvider, streamWithProvider } from "./providers";
import { providerForModel } from "./models";
import {
    completeOpenAICompatibleText,
    streamOpenAICompatible,
} from "./openaiCompatible";
import {
    completeCommitteeText,
    isCommitteeId,
    streamCommitteeChat,
} from "./committee";
import { getConfiguredModel } from "./registry";
import { OPENROUTER_API_BASE_URL } from "./openrouterCatalog";
import { openRouterModelId } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    if (isCommitteeId(params.model)) return streamCommitteeChat(params);
    if (providerForModel(params.model) === "openai-compatible") {
        return streamOpenAICompatible(params);
    }
    return streamWithProvider(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
    committeeStack?: string[];
    requestTimeoutMs?: number;
    reasoningEffort?: string;
    responseFormat?: Record<string, unknown>;
    plugins?: Array<{ id: string }>;
}): Promise<string> {
    if (isCommitteeId(params.model)) return completeCommitteeText(params);
    // OpenRouter's structured-output and plugin controls (playbook compilation
    // relies on both) have no equivalent in the AI SDK provider, which drops
    // them silently. Send those requests through the OpenAI-compatible client,
    // which forwards response_format and plugins verbatim.
    if (
        (params.responseFormat || params.plugins?.length) &&
        providerForModel(params.model) === "openrouter"
    ) {
        return completeOpenAICompatibleText({
            model: {
                id: params.model,
                provider: "openai-compatible",
                location: "cloud",
                apiModel: openRouterModelId(params.model),
                baseUrl: OPENROUTER_API_BASE_URL,
                apiKeyProvider: "openrouter",
            },
            systemPrompt: params.systemPrompt,
            user: params.user,
            maxTokens: params.maxTokens,
            apiKeys: params.apiKeys,
            requestTimeoutMs: params.requestTimeoutMs,
            reasoningEffort: params.reasoningEffort,
            responseFormat: params.responseFormat,
            plugins: params.plugins,
        });
    }
    if (providerForModel(params.model) === "openai-compatible") {
        const configured = getConfiguredModel(params.model);
        if (!configured) {
            throw new Error(`Unknown configured model: ${params.model}`);
        }
        return completeOpenAICompatibleText({
            model: configured,
            systemPrompt: params.systemPrompt,
            user: params.user,
            maxTokens: params.maxTokens,
            apiKeys: params.apiKeys,
            requestTimeoutMs: params.requestTimeoutMs,
            reasoningEffort: params.reasoningEffort,
            responseFormat: params.responseFormat,
            plugins: params.plugins,
        });
    }
    return completeWithProvider(params);
}
