import { describe, expect, it, vi } from "vitest";

const { completeMock, streamMock } = vi.hoisted(() => ({
    completeMock: vi.fn().mockResolvedValue("kimi"),
    streamMock: vi.fn().mockResolvedValue({ fullText: "stream" }),
}));
vi.mock("./providers", () => ({ completeWithProvider: completeMock, streamWithProvider: streamMock }));
import { completeText, streamChatWithTools } from "./index";

describe("AI SDK provider dispatch", () => {
    it("forwards completion model, credentials and reasoning effort to provider selection", async () => {
        const params = { model: "kimi-k3", user: "Hello", reasoningEffort: "low" as const, apiKeys: { kimi: "org-key" } };
        await expect(completeText(params)).resolves.toBe("kimi");
        expect(completeMock).toHaveBeenCalledWith(params);
    });
    it("forwards the stream and abort signal to the shared adapter", async () => {
        const abort = new AbortController();
        const params = { model: "aoai:production", systemPrompt: "", messages: [{ role: "user" as const, content: "Hello" }], abortSignal: abort.signal };
        await expect(streamChatWithTools(params)).resolves.toEqual({ fullText: "stream" });
        expect(streamMock).toHaveBeenCalledWith(params);
    });
});
