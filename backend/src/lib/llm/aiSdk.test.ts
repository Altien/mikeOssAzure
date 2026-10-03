import { describe, expect, it, vi } from "vitest";

const { streamTextMock } = vi.hoisted(() => ({
    streamTextMock: vi.fn(() => ({ stream: { async *[Symbol.asyncIterator]() {} } })),
}));
vi.mock("ai", () => ({
    streamText: streamTextMock,
    stepCountIs: (count: number) => ({ count }),
    jsonSchema: (schema: unknown) => schema,
    tool: (definition: unknown) => definition,
}));
import { streamAiSdk } from "./aiSdk";

describe("shared AI SDK step preparation", () => {
    it("composes the CourtListener reminder with final tool disablement and forwards abort", async () => {
        const abort = new AbortController();
        await streamAiSdk({
            model: "gpt-5.4", systemPrompt: "Base instructions", messages: [],
            maxIterations: 1, abortSignal: abort.signal,
        }, {
            provider: "openai", label: "OpenAI", model: {} as never,
            modelId: "gpt-5.4", courtlistenerCitationReminder: true,
        });
        const options = streamTextMock.mock.calls.at(-1)?.[0] as {
            abortSignal: AbortSignal;
            stopWhen: { count: number };
            prepareStep: (args: { steps: Array<{ toolCalls: Array<{ toolName: string }> }> }) => Record<string, unknown>;
        };
        expect(options.abortSignal).toBe(abort.signal);
        expect(options.stopWhen.count).toBe(2);
        expect(options.prepareStep({ steps: [] })).toEqual({});
        expect(options.prepareStep({ steps: [{ toolCalls: [{ toolName: "courtlistener_read_case" }] }] })).toMatchObject({
            activeTools: [], toolChoice: "none",
            system: expect.stringContaining("COURTLISTENER CITATION REMINDER"),
        });
    });
});
