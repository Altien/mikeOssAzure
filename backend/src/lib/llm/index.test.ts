import { describe, expect, it, vi } from "vitest";

const { completeKimiMock, completeAzureMock } = vi.hoisted(() => ({
    completeKimiMock: vi.fn().mockResolvedValue("kimi"),
    completeAzureMock: vi.fn().mockResolvedValue("azure"),
}));

vi.mock("./claude", () => ({
    streamClaude: vi.fn(),
    completeClaudeText: vi.fn(),
}));
vi.mock("./gemini", () => ({
    streamGemini: vi.fn(),
    completeGeminiText: vi.fn(),
}));
vi.mock("./openai", () => ({
    streamOpenAI: vi.fn(),
    completeOpenAIText: vi.fn(),
}));
vi.mock("./kimi", () => ({
    streamKimi: vi.fn(),
    completeKimiText: completeKimiMock,
}));
vi.mock("./azureOpenai", () => ({
    streamAzureOpenAI: vi.fn(),
    completeAzureOpenAIText: completeAzureMock,
}));

import { completeText } from "./index";

describe("Kimi K3 dispatch", () => {
    it("sends kimi-k3 completions to the Kimi adapter", async () => {
        await expect(
            completeText({ model: "kimi-k3", user: "Hello" }),
        ).resolves.toBe("kimi");
        expect(completeKimiMock).toHaveBeenCalledOnce();
        expect(completeAzureMock).not.toHaveBeenCalled();
    });
});
