import { beforeEach, describe, expect, it, vi } from "vitest";

const { constructorMock, createMock, resolveSecretMock } = vi.hoisted(() => ({
    constructorMock: vi.fn(),
    createMock: vi.fn(),
    resolveSecretMock: vi.fn(),
}));

vi.mock("openai", () => ({
    default: class {
        chat = { completions: { create: createMock } };

        constructor(options: unknown) {
            constructorMock(options);
        }
    },
}));
vi.mock("../envSecrets", () => ({
    resolveSecret: resolveSecretMock,
}));

import { completeKimiText, streamKimi } from "./kimi";

function asyncChunks(chunks: unknown[]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
        },
    };
}

describe("Kimi K3 API adapter", () => {
    beforeEach(() => {
        constructorMock.mockReset();
        createMock.mockReset();
        resolveSecretMock.mockReset();
        resolveSecretMock.mockResolvedValue("");
        createMock.mockResolvedValue({
            choices: [{ message: { content: "Kimi response" } }],
        });
    });

    it("directs missing organisation credentials to /install", async () => {
        await expect(
            completeKimiText({ model: "kimi-k3", user: "Hello" }),
        ).rejects.toThrow(
            /Kimi K3.*administrator.*\/install.*moonshot-api-key/i,
        );
    });

    it("uses the Moonshot OpenAI-compatible endpoint and kimi-k3 model", async () => {
        await expect(
            completeKimiText({
                model: "kimi-k3",
                user: "Hello",
                apiKeys: { kimi: "org-kimi-key" },
            }),
        ).resolves.toBe("Kimi response");

        expect(constructorMock).toHaveBeenCalledWith({
            apiKey: "org-kimi-key",
            baseURL: "https://api.moonshot.ai/v1",
        });
        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "kimi-k3",
                max_completion_tokens: 512,
            }),
        );
    });

    it("preserves K3 reasoning content across tool-call turns", async () => {
        createMock
            .mockResolvedValueOnce(
                asyncChunks([
                    {
                        choices: [
                            {
                                delta: { reasoning_content: "Need a lookup." },
                                finish_reason: null,
                            },
                        ],
                    },
                    {
                        choices: [
                            {
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call-1",
                                            function: {
                                                name: "lookup",
                                                arguments: '{"term":"law"}',
                                            },
                                        },
                                    ],
                                },
                                finish_reason: "tool_calls",
                            },
                        ],
                    },
                ]),
            )
            .mockResolvedValueOnce(
                asyncChunks([
                    {
                        choices: [
                            {
                                delta: { content: "Final answer" },
                                finish_reason: "stop",
                            },
                        ],
                    },
                ]),
            );
        const onReasoningDelta = vi.fn();

        await expect(
            streamKimi({
                model: "kimi-k3",
                systemPrompt: "",
                messages: [{ role: "user", content: "Research this" }],
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
                callbacks: { onReasoningDelta },
                runTools: vi.fn().mockResolvedValue([
                    { tool_use_id: "call-1", content: "result" },
                ]),
                apiKeys: { kimi: "org-kimi-key" },
            }),
        ).resolves.toEqual({ fullText: "Final answer" });

        expect(onReasoningDelta).toHaveBeenCalledWith("Need a lookup.");
        expect(createMock.mock.calls[1][0].messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: "assistant",
                    reasoning_content: "Need a lookup.",
                }),
            ]),
        );
    });
});
