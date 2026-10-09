import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "./providers";

function completionResponse(text = "Kimi response") {
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }), {
        status: 200, headers: { "content-type": "application/json" },
    });
}
function streamResponse(chunks: unknown[]) {
    const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const lookup = { type: "function" as const, function: { name: "lookup", description: "Look up", parameters: { type: "object" } } };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Kimi AI SDK transport", () => {
    it("uses Moonshot, replays reasoning in the assistant tool-call turn, and disables tools for final synthesis", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(streamResponse([
                { choices: [{ delta: { reasoning_content: "Need a lookup." }, finish_reason: null }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"term":"law"}' } }] }, finish_reason: "tool_calls" }] },
            ]))
            .mockResolvedValueOnce(streamResponse([{ choices: [{ delta: { content: "Final answer" }, finish_reason: "stop" }] }]));
        vi.stubGlobal("fetch", fetchMock);
        const onReasoningDelta = vi.fn();
        const runTools = vi.fn().mockResolvedValue([{ tool_use_id: "call-1", content: "result" }]);
        await expect(streamWithProvider({
            model: "kimi-k3", systemPrompt: "", messages: [{ role: "user", content: "Research this" }],
            tools: [lookup], maxIterations: 1, runTools, callbacks: { onReasoningDelta },
            apiKeys: { kimi: "org-kimi-key" },
        })).resolves.toEqual({ fullText: "Final answer" });
        expect(runTools).toHaveBeenCalledTimes(1);
        expect(onReasoningDelta).toHaveBeenCalledWith("Need a lookup.");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toBe("https://api.moonshot.ai/v1/chat/completions");
        expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("authorization")).toBe("Bearer org-kimi-key");
        const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
        expect(second).not.toHaveProperty("tools");
        expect(second.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", reasoning_content: "Need a lookup." })]));
    });

    it("starts with tools disabled when the tool budget is zero", async () => {
        const fetchMock = vi.fn().mockResolvedValue(streamResponse([{ choices: [{ delta: { content: "No tools needed" }, finish_reason: "stop" }] }]));
        vi.stubGlobal("fetch", fetchMock);
        const runTools = vi.fn();
        await expect(streamWithProvider({ model: "kimi-k3", systemPrompt: "", messages: [{ role: "user", content: "Hello" }], tools: [lookup], maxIterations: 0, runTools, apiKeys: { kimi: "org-kimi-key" } })).resolves.toEqual({ fullText: "No tools needed" });
        expect(runTools).not.toHaveBeenCalled();
        expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).not.toHaveProperty("tools");
    });

    it("maps explicit none to low, preserves max, and omits unset effort", async () => {
        const fetchMock = vi.fn().mockImplementation(async () => completionResponse());
        vi.stubGlobal("fetch", fetchMock);
        for (const reasoningEffort of ["none", "max", undefined] as const) {
            await expect(completeWithProvider({ model: "kimi-k3", user: "Analyse", reasoningEffort, apiKeys: { kimi: "org-kimi-key" } })).resolves.toBe("Kimi response");
        }
        const bodies = fetchMock.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));
        expect(bodies[0].reasoning_effort).toBe("low");
        expect(bodies[1].reasoning_effort).toBe("max");
        expect(bodies[2]).not.toHaveProperty("reasoning_effort");
        expect(bodies.every(body => !Object.hasOwn(body, "thinking"))).toBe(true);
    });
});
