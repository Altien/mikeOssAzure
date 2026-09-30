import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => ({
    AzureOpenAI: class {
        chat = { completions: { create: createMock } };
    },
}));

vi.mock("../envSecrets", () => ({
    resolveSecret: vi.fn(async (name: string) =>
        name === "azure-openai-endpoint"
            ? "https://example.openai.azure.com"
            : "test-key",
    ),
}));

import { completeAzureOpenAIText } from "./azureOpenai";

describe("completeAzureOpenAIText", () => {
    beforeEach(() => {
        createMock.mockReset();
        createMock.mockResolvedValue({
            choices: [{ message: { content: "A short title" } }],
        });
    });

    it("forwards the requested reasoning effort", async () => {
        await completeAzureOpenAIText({
            model: "aoai:gpt-5-mini",
            user: "Title this chat",
            maxTokens: 32,
            reasoningEffort: "none",
        });

        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({ reasoning_effort: "none" }),
        );
    });
});
