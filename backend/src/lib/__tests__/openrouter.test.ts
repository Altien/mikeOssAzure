import { afterEach, describe, expect, it, vi } from "vitest";
import {
    completeOpenRouterText,
    completeVercelText,
    streamOpenRouter,
} from "../llm/openrouter";

function streamResponse(chunks: unknown[]): Response {
    const body = `${chunks
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("")}data: [DONE]\n\n`;
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

describe("OpenRouter LLM adapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses the saved key and removes the internal model namespace", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "A short title" } }],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeOpenRouterText({
            model: "openrouter/openai/gpt-5.4",
            user: "Title this",
            apiKeys: { openrouter: "or-user-key" },
        });

        expect(result).toBe("A short title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(init.headers).toMatchObject({
            Authorization: "Bearer or-user-key",
        });
        expect(JSON.parse(String(init.body))).toMatchObject({
            model: "openai/gpt-5.4",
            stream: false,
        });
    });

    it("streams reasoning and content and continues after a tool call", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                streamResponse([
                    {
                        choices: [
                            {
                                delta: {
                                    reasoning: "Checking",
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call-1",
                                            function: {
                                                name: "lookup",
                                                arguments:
                                                    '{"term":"contract"}',
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ]),
            )
            .mockResolvedValueOnce(
                streamResponse([{ choices: [{ delta: { content: "Done" } }] }]),
            );
        vi.stubGlobal("fetch", fetchMock);
        const onReasoningDelta = vi.fn();
        const onReasoningBlockEnd = vi.fn();
        const onContentDelta = vi.fn();
        const onToolCallStart = vi.fn();
        const runTools = vi
            .fn()
            .mockResolvedValue([{ tool_use_id: "call-1", content: "result" }]);

        const result = await streamOpenRouter({
            model: "openrouter/anthropic/claude-sonnet-4.5",
            systemPrompt: "Help",
            messages: [{ role: "user", content: "Review" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "lookup",
                        description: "Look something up",
                        parameters: { type: "object" },
                    },
                },
            ],
            apiKeys: { openrouter: "or-user-key" },
            enableThinking: true,
            callbacks: {
                onReasoningDelta,
                onReasoningBlockEnd,
                onContentDelta,
                onToolCallStart,
            },
            runTools,
        });

        expect(result.fullText).toBe("Done");
        expect(onReasoningDelta).toHaveBeenCalledWith("Checking");
        expect(onReasoningBlockEnd).toHaveBeenCalledOnce();
        expect(onContentDelta).toHaveBeenCalledWith("Done");
        expect(onToolCallStart).toHaveBeenCalledWith({
            id: "call-1",
            name: "lookup",
            input: { term: "contract" },
        });
        expect(runTools).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const secondBody = JSON.parse(
            String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
        );
        expect(secondBody.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ role: "assistant" }),
                { role: "tool", tool_call_id: "call-1", content: "result" },
            ]),
        );
    });
});

describe("Vercel AI Gateway LLM adapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses the Vercel key, endpoint, and unprefixed model ID", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "A Vercel title" } }],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeVercelText({
            model: "vercel/openai/gpt-5.4",
            user: "Title this",
            apiKeys: { vercel: "vercel-user-key" },
        });

        expect(result).toBe("A Vercel title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
        expect(init.headers).toMatchObject({
            Authorization: "Bearer vercel-user-key",
        });
        expect(init.headers).not.toHaveProperty("X-Title");
        expect(JSON.parse(String(init.body))).toMatchObject({
            model: "openai/gpt-5.4",
            stream: false,
        });
    });
});
