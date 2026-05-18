import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    AzureOpenaiSettings,
} from "./types";
import { resolveSecret } from "../envSecrets";

// Azure OpenAI is the same chat-completions API as classic OpenAI but
// with extra connection parameters: endpoint, apiVersion, and deployment
// (the deployment name is what gets sent as `model` in the request).
//
// Currently keyed on the user's `azureOpenai` settings or the backend's
// AZURE_OPENAI_* env vars as a global fallback. Managed-identity auth
// is a separate ticket that needs `@azure/identity` + a
// `getBearerTokenProvider` flow.

const DEFAULT_API_VERSION = "2024-10-21";

// Resolve endpoint + key + apiVersion from user override, then KV (via
// resolveSecret which checks env first), then default. Deployment is
// intentionally NOT resolved here — it comes from the model id
// (`aoai:<deployment>`) so the caller can pick any of the deployments
// returned by deployment discovery, not just one default.
//
// KV path covers marketplace installs where the configurator writes
// azure-openai-endpoint + azure-openai-api-key without any Bicep env
// wiring. Closes 040 Entry 12 for AOAI.
async function resolveCredentials(
    override?: AzureOpenaiSettings | null,
): Promise<{ endpoint: string; apiKey: string; apiVersion: string }> {
    const endpoint =
        override?.endpoint?.trim() || await resolveSecret("azure-openai-endpoint");
    const apiKey =
        override?.apiKey?.trim() || await resolveSecret("azure-openai-api-key");
    const apiVersion =
        override?.apiVersion?.trim() ||
        process.env.AZURE_OPENAI_API_VERSION ||
        DEFAULT_API_VERSION;

    if (!endpoint) {
        throw new Error(
            "Azure OpenAI not configured: endpoint missing (set azure-openai-endpoint in KV via /install, AZURE_OPENAI_ENDPOINT env, or the user's azure_openai_endpoint).",
        );
    }
    if (!apiKey) {
        throw new Error(
            "Azure OpenAI not configured: apiKey missing. Managed-identity auth is not implemented yet.",
        );
    }
    return { endpoint, apiKey, apiVersion };
}

// Strip the `aoai:` prefix from a model id and validate the deployment
// portion. Falls back to the user's stored default deployment / env var
// when the caller used the legacy `aoai:default` sentinel — preserves
// the stopgap behaviour for any old saved selections.
function deploymentFromModelId(
    modelId: string,
    override?: AzureOpenaiSettings | null,
): string {
    const fromModel = modelId.startsWith("aoai:")
        ? modelId.slice("aoai:".length).trim()
        : "";
    if (fromModel && fromModel !== "default") return fromModel;
    const fallback =
        override?.deployment?.trim() ||
        process.env.AZURE_OPENAI_DEPLOYMENT?.trim() ||
        "";
    if (!fallback) {
        throw new Error(
            "Azure OpenAI deployment missing. Pick a specific deployment in the model picker, or set a default deployment in Account → Models.",
        );
    }
    return fallback;
}

async function client(
    deployment: string,
    override?: AzureOpenaiSettings | null,
): Promise<AzureOpenAI> {
    const c = await resolveCredentials(override);
    return new AzureOpenAI({
        apiKey: c.apiKey,
        endpoint: c.endpoint,
        apiVersion: c.apiVersion,
        deployment,
    });
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
    systemPrompt: string,
): ChatCompletionMessageParam[] {
    const out: ChatCompletionMessageParam[] = [];
    if (systemPrompt) out.push({ role: "system", content: systemPrompt });
    for (const m of messages) {
        out.push({ role: m.role, content: m.content });
    }
    return out;
}

type AccumulatedToolCall = {
    id: string;
    name: string;
    argsBuffer: string;
};

export async function streamAzureOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const deployment = deploymentFromModelId(model, apiKeys?.azureOpenai);
    const aoai = await client(deployment, apiKeys?.azureOpenai);

    const messages = toNativeMessages(params.messages, systemPrompt);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        // For AzureOpenAI clients constructed with `deployment`, the
        // `model` field on the request is overridden by the deployment
        // route — we still pass it as the deployment name for clarity.
        const stream = await aoai.chat.completions.create({
            model: deployment,
            messages,
            tools: tools.length ? tools : undefined,
            stream: true,
        });

        const acc = new Map<number, AccumulatedToolCall>();
        let assistantText = "";
        let finishReason: string | null = null;

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;
            const delta = choice.delta;
            if (delta?.content) {
                assistantText += delta.content;
                callbacks.onContentDelta?.(delta.content);
            }
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    const existing = acc.get(idx) ?? {
                        id: "",
                        name: "",
                        argsBuffer: "",
                    };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) {
                        existing.argsBuffer += tc.function.arguments;
                    }
                    acc.set(idx, existing);
                }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        fullText += assistantText;

        const toolCalls: NormalizedToolCall[] = [];
        for (const [, raw] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
            let parsedInput: Record<string, unknown> = {};
            if (raw.argsBuffer.trim()) {
                try {
                    parsedInput = JSON.parse(raw.argsBuffer) as Record<
                        string,
                        unknown
                    >;
                } catch (err) {
                    console.error(
                        "[azureOpenai] failed to parse tool call args",
                        { name: raw.name, argsBuffer: raw.argsBuffer, err },
                    );
                }
            }
            const call: NormalizedToolCall = {
                id: raw.id || `${raw.name}-${toolCalls.length}`,
                name: raw.name,
                input: parsedInput,
            };
            callbacks.onToolCallStart?.(call);
            toolCalls.push(call);
        }

        if (finishReason !== "tool_calls" || !toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);
        messages.push({
            role: "assistant",
            content: assistantText || null,
            tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input),
                },
            })),
        });
        for (const r of results) {
            messages.push({
                role: "tool",
                tool_call_id: r.tool_use_id,
                content: r.content,
            });
        }
    }

    return { fullText };
}

export async function completeAzureOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { azureOpenai?: AzureOpenaiSettings | null };
}): Promise<string> {
    const deployment = deploymentFromModelId(
        params.model,
        params.apiKeys?.azureOpenai,
    );
    const aoai = await client(deployment, params.apiKeys?.azureOpenai);
    const messages: ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });
    const resp = await aoai.chat.completions.create({
        model: deployment,
        messages,
        max_completion_tokens: params.maxTokens ?? 512,
    });
    return resp.choices[0]?.message?.content ?? "";
}
