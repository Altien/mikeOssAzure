import type {
    LlmMessage,
    NormalizedToolCall,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";
import { openRouterModelId, vercelModelId } from "./models";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const OPENROUTER_CHAT_URL =
    process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://openrouter.ai/api/v1";
const VERCEL_CHAT_URL =
    process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://ai-gateway.vercel.sh/v1";

type RouterProvider = "openrouter" | "vercel";

function routerForModel(model: string): RouterProvider {
    return model.startsWith("vercel/") ? "vercel" : "openrouter";
}

function routerLabel(provider: RouterProvider): string {
    return provider === "vercel" ? "Vercel AI Gateway" : "OpenRouter";
}

type ToolCallPayload = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

type ChatMessage =
    | { role: "system" | "user" | "assistant"; content: string }
    | {
          role: "assistant";
          content: string;
          tool_calls: ToolCallPayload[];
          reasoning?: string;
          reasoning_details?: unknown[];
      }
    | { role: "tool"; tool_call_id: string; content: string };

type PartialToolCall = { id: string; name: string; arguments: string };

function apiKey(provider: RouterProvider, override?: string | null): string {
    const key =
        override?.trim() ||
        (provider === "vercel"
            ? process.env.AI_GATEWAY_API_KEY?.trim() ||
              process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
            : process.env.OPENROUTER_API_KEY?.trim()) ||
        "";
    if (!key) {
        throw new Error(
            `${routerLabel(provider)} API key is not configured. ${
                provider === "vercel"
                    ? "Set AI_GATEWAY_API_KEY"
                    : "Set OPENROUTER_API_KEY"
            } or add a user ${routerLabel(provider)} key.`,
        );
    }
    return key;
}

function initialMessages(
    systemPrompt: string,
    messages: LlmMessage[],
): ChatMessage[] {
    const result: ChatMessage[] = [];
    if (systemPrompt.trim()) {
        result.push({ role: "system", content: systemPrompt });
    }
    for (const message of messages) {
        result.push({ role: message.role, content: message.content });
    }
    return result;
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error("Stream aborted.");
    error.name = "AbortError";
    throw error;
}

async function postChat(args: {
    provider: RouterProvider;
    key: string;
    body: unknown;
    signal?: AbortSignal;
}): Promise<Response> {
    const baseUrl =
        args.provider === "vercel" ? VERCEL_CHAT_URL : OPENROUTER_CHAT_URL;
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${args.key}`,
            "Content-Type": "application/json",
            ...(args.provider === "openrouter" && process.env.FRONTEND_URL
                ? { "HTTP-Referer": process.env.FRONTEND_URL }
                : {}),
            ...(args.provider === "openrouter" ? { "X-Title": "Mike" } : {}),
        },
        body: JSON.stringify(args.body),
        signal: args.signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
            `${routerLabel(args.provider)} request failed (${response.status}): ${text || response.statusText}`,
        );
    }
    return response;
}

function parseToolCalls(
    partials: Map<number, PartialToolCall>,
    provider: RouterProvider,
) {
    return [...partials.values()].map((partial): NormalizedToolCall => {
        // No arguments at all is legitimate (parameter-less tools stream "");
        // arguments that are PRESENT but unparseable mean the stream was
        // truncated or corrupted mid-call. Coercing those to {} would run a
        // side-effecting tool with empty input, so fail the stream instead —
        // the same path a mid-stream {"error"} chunk takes.
        let input: Record<string, unknown> = {};
        if (partial.arguments.trim()) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(partial.arguments);
            } catch {
                throw new Error(
                    `${routerLabel(provider)} stream ended with malformed JSON arguments for tool "${partial.name}"; refusing to execute it with empty input.`,
                );
            }
            if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
            ) {
                throw new Error(
                    `${routerLabel(provider)} stream produced non-object arguments for tool "${partial.name}"; refusing to execute it with empty input.`,
                );
            }
            input = parsed as Record<string, unknown>;
        }
        return {
            id: partial.id || partial.name,
            name: partial.name,
            input,
        };
    });
}

export async function streamOpenRouter(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        enableThinking,
    } = params;
    const provider = routerForModel(model);
    const key = apiKey(
        provider,
        provider === "vercel"
            ? params.apiKeys?.vercel
            : params.apiKeys?.openrouter,
    );
    const maxIterations = params.maxIterations ?? 10;
    const messages = initialMessages(systemPrompt, params.messages);
    const rawStreamRecorder = createRawLlmStreamRecorder({
        provider,
        model,
    });
    let fullText = "";

    try {
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            throwIfAborted(params.abortSignal);
            const response = await postChat({
                provider,
                key,
                signal: params.abortSignal,
                body: {
                    model:
                        provider === "vercel"
                            ? vercelModelId(model)
                            : openRouterModelId(model),
                    messages,
                    tools: tools.length
                        ? (tools as OpenAIToolSchema[])
                        : undefined,
                    stream: true,
                    ...(provider === "openrouter"
                        ? {
                              reasoning: enableThinking
                                  ? {
                                        enabled: true,
                                        effort: "high",
                                        exclude: false,
                                    }
                                  : undefined,
                          }
                        : {
                              reasoning_effort: enableThinking
                                  ? "high"
                                  : undefined,
                          }),
                },
            });
            if (!response.body) {
                throw new Error(
                    `${routerLabel(provider)} response had no body`,
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const partials = new Map<number, PartialToolCall>();
            const reasoningDetails: unknown[] = [];
            let assistantText = "";
            let assistantReasoning = "";
            let buffer = "";

            const processSseLine = (rawLine: string) => {
                const line = rawLine.trim();
                if (!line.startsWith("data:")) return;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") return;

                let chunk: Record<string, unknown>;
                try {
                    chunk = JSON.parse(data) as Record<string, unknown>;
                } catch {
                    return;
                }
                logRawLlmStream({
                    provider,
                    model,
                    iteration,
                    label: "chunk",
                    payload: chunk,
                });
                rawStreamRecorder?.record({
                    iteration,
                    label: "chunk",
                    payload: chunk,
                });

                const error = chunk.error as
                    | { code?: unknown; message?: unknown }
                    | undefined;
                if (error) {
                    const message =
                        typeof error.message === "string"
                            ? error.message
                            : `${routerLabel(provider)} stream failed.`;
                    throw new Error(
                        error.code
                            ? `${routerLabel(provider)} error (${String(error.code)}): ${message}`
                            : `${routerLabel(provider)} error: ${message}`,
                    );
                }

                const choice = (
                    chunk.choices as
                        | Array<{ delta?: Record<string, unknown> }>
                        | undefined
                )?.[0];
                const delta = choice?.delta;
                if (!delta) return;

                if (typeof delta.content === "string" && delta.content) {
                    assistantText += delta.content;
                    fullText += delta.content;
                    callbacks.onContentDelta?.(delta.content);
                }
                if (typeof delta.reasoning === "string" && delta.reasoning) {
                    assistantReasoning += delta.reasoning;
                    callbacks.onReasoningDelta?.(delta.reasoning);
                }
                if (Array.isArray(delta.reasoning_details)) {
                    reasoningDetails.push(...delta.reasoning_details);
                }

                const toolCallDeltas = Array.isArray(delta.tool_calls)
                    ? (delta.tool_calls as Array<Record<string, unknown>>)
                    : [];
                for (const toolCall of toolCallDeltas) {
                    const index =
                        typeof toolCall.index === "number" ? toolCall.index : 0;
                    const accumulated = partials.get(index) ?? {
                        id: "",
                        name: "",
                        arguments: "",
                    };
                    if (typeof toolCall.id === "string") {
                        accumulated.id = toolCall.id;
                    }
                    const fn = toolCall.function as
                        | { name?: unknown; arguments?: unknown }
                        | undefined;
                    if (typeof fn?.name === "string") {
                        accumulated.name = fn.name;
                    }
                    if (typeof fn?.arguments === "string") {
                        accumulated.arguments += fn.arguments;
                    }
                    partials.set(index, accumulated);
                }
            };

            while (true) {
                throwIfAborted(params.abortSignal);
                const { done, value } = await reader.read();
                if (done) {
                    // A proxy may close the stream without a trailing newline:
                    // flush what the decoder still buffers and process the
                    // residual line so the final delta is not dropped.
                    buffer += decoder.decode();
                    if (buffer.trim()) {
                        for (const line of buffer.split("\n")) {
                            processSseLine(line);
                        }
                    }
                    buffer = "";
                    break;
                }
                buffer += decoder.decode(value, { stream: true });

                let newlineIndex: number;
                while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    processSseLine(line);
                }
            }

            if (assistantReasoning) callbacks.onReasoningBlockEnd?.();
            const toolCalls = parseToolCalls(partials, provider);
            if (!toolCalls.length || !runTools) break;

            messages.push({
                role: "assistant",
                content: assistantText,
                tool_calls: toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input),
                    },
                })),
                ...(assistantReasoning
                    ? { reasoning: assistantReasoning }
                    : {}),
                ...(reasoningDetails.length
                    ? { reasoning_details: reasoningDetails }
                    : {}),
            });
            for (const call of toolCalls) {
                callbacks.onToolCallStart?.(call);
            }
            const results = await runTools(toolCalls);
            for (const result of results) {
                messages.push({
                    role: "tool",
                    tool_call_id: result.tool_use_id,
                    content: result.content,
                });
            }
        }

        await rawStreamRecorder?.flush("completed");
        return { fullText };
    } catch (error) {
        await rawStreamRecorder?.flush("error", error);
        throw error;
    }
}

export async function completeOpenRouterText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: {
        openrouter?: string | null;
        vercel?: string | null;
    };
}): Promise<string> {
    const provider = routerForModel(params.model);
    const response = await postChat({
        provider,
        key: apiKey(
            provider,
            provider === "vercel"
                ? params.apiKeys?.vercel
                : params.apiKeys?.openrouter,
        ),
        body: {
            model:
                provider === "vercel"
                    ? vercelModelId(params.model)
                    : openRouterModelId(params.model),
            messages: initialMessages(params.systemPrompt ?? "", [
                { role: "user", content: params.user },
            ]),
            max_tokens: params.maxTokens ?? 512,
            stream: false,
        },
    });
    const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
}

export const streamVercel = streamOpenRouter;
export const completeVercelText = completeOpenRouterText;
