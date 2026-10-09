import { afterEach, describe, expect, it, vi } from "vitest";

import { completeWithProvider } from "../llm/providers";
import { resetModelRegistryCache } from "../llm/registry";
import type { ConfiguredModel } from "../llm/types";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

function configure(maxTokensField?: ConfiguredModel["maxTokensField"]) {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
        models: [
            {
                id: "custom-model",
                provider: "openai-compatible",
                location: "cloud",
                apiModel: "upstream-model",
                baseUrl: "https://models.example.test/v1",
                ...(maxTokensField ? { maxTokensField } : {}),
            },
        ],
    });
    resetModelRegistryCache();
}

function completionResponse(): Response {
    return new Response(
        JSON.stringify({
            choices: [
                {
                    message: { role: "assistant", content: "Done" },
                    finish_reason: "stop",
                },
            ],
        }),
        {
            status: 200,
            headers: { "Content-Type": "application/json" },
        },
    );
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("configured OpenAI-compatible models", () => {
    afterEach(() => {
        if (originalConfig === undefined) {
            delete process.env.MIKE_MODEL_CONFIG_JSON;
        } else {
            process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
        }
        resetModelRegistryCache();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses max_tokens by default", async () => {
        configure();
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);

        await completeWithProvider({
            model: "custom-model",
            user: "Complete this",
            maxTokens: 321,
        });

        expect(requestBody(fetchMock)).toMatchObject({
            model: "upstream-model",
            max_tokens: 321,
        });
        expect(requestBody(fetchMock)).not.toHaveProperty(
            "max_completion_tokens",
        );
    });

    it("can send max_completion_tokens instead", async () => {
        configure("max_completion_tokens");
        const fetchMock = vi.fn().mockResolvedValue(completionResponse());
        vi.stubGlobal("fetch", fetchMock);

        await completeWithProvider({
            model: "custom-model",
            user: "Complete this",
            maxTokens: 321,
        });

        expect(requestBody(fetchMock)).toMatchObject({
            model: "upstream-model",
            max_completion_tokens: 321,
        });
        expect(requestBody(fetchMock)).not.toHaveProperty("max_tokens");
    });
});
