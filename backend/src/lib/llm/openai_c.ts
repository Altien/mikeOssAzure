import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { resolveSecret } from "../envSecrets";

// OpenAI's tool-call schema is what the rest of the codebase calls
// OpenAIToolSchema, so we pass tools through untouched. Streaming and
// tool-call assembly are the only things the adapter has to do.

// Upstream divergence (sync-log: a2368a7): upstream's adapter is a raw
// fetch against the Responses API with a sync env-var apiKey(); dev uses
// the official SDK with Key Vault-first secret resolution (lib/envSecrets,
// internal design notes §2.4). Upstream's hard fail on a missing key is
// preserved here; its status-tagging of Responses-API fetch errors is N/A
// (the SDK's APIError already carries `status`).
// Upstream divergence (sync-log: 44e868e): upstream further reworked its
// Responses-API adapter (abortSignal plumbing, raw-stream logging via
// rawStreamLog, stream-failure message parsing, reasoning summaries).
// Those changes target upstream's raw-fetch implementation and were not
// ported onto dev's SDK adapter; abortSignal on StreamChatParams is
// accepted but currently ignored here.
async function apiKey(override?: string | null): Promise<string> {
    const key = override?.trim() || (await resolveSecret("openai-api-key"));
    if (!key) {
        throw new Error(
            "OpenAI API key is not configured. Set the openai-api-key Key Vault secret (or its env fallback) or add a user OpenAI key.",
        );
    }
    return key;
}

async function client(override?: string | null): Promise<OpenAI> {
    const apiKeyValue = await apiKey(override);
    // Base URL must be resolved explicitly now that ANTHROPIC_API_KEY /
    // OPENAI_API_KEY env vars are no longer wired via Container App
    // secretRef (see infra/modules/containerapp-backend.bicep — the AI
    // env-var bridge was removed to fix the redeploy-clobber bug, 040
    // Entry 19). The OpenAI SDK used to auto-read OPENAI_BASE_URL; now
    // we pass it via the constructor. undefined leaves the SDK default
    // (api.openai.com).
    const baseURL = (await resolveSecret("openai-base-url")) || undefined;
    return new OpenAI({ apiKey: apiKeyValue, baseURL });
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

// OpenAI streams tool calls as deltas keyed by `index`, with each delta
// contributing fragments of `id`, `function.name`, and `function.arguments`.
// We accumulate per-index, then parse the final `arguments` JSON once
// streaming completes.
type AccumulatedToolCall = {
    id: string;
    name: string;
    argsBuffer: string;
};

export async function streamOpenAI(
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
    const openai = await client(apiKeys?.openai);

    const messages = toNativeMessages(params.messages, systemPrompt);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = await openai.chat.completions.create({
            model,
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
                    console.error("[openai] failed to parse tool call args", {
                        name: raw.name,
                        argsBuffer: raw.argsBuffer,
                        err,
                    });
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

        // Append the assistant turn that issued the tool_calls, then one
        // tool message per result (OpenAI requires a separate message per
        // tool result, keyed by tool_call_id).
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

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const openai = await client(params.apiKeys?.openai);
    const messages: ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });
    const resp = await openai.chat.completions.create({
        model: params.model,
        messages,
        max_completion_tokens: params.maxTokens ?? 512,
    });
    return resp.choices[0]?.message?.content ?? "";
}

export type { NormalizedToolResult };
