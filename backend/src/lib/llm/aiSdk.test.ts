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
import { streamAiSdk, DEFAULT_MAX_ITERATIONS, stopNotice } from "./aiSdk";

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

describe("stopNotice", () => {
  it("says nothing when the model finished on its own", () => {
    expect(stopNotice(3, DEFAULT_MAX_ITERATIONS, "stop")).toBe("");
  });

  it("says nothing when the round count is a coincidence", () => {
    // Used every round AND finished. Warning here would put a scary footer
    // under a perfectly good answer.
    expect(
      stopNotice(DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS, "stop"),
    ).toBe("");
  });

  it("names the step limit when the model was cut off mid-work", () => {
    // Still asking for tools on the final round: stopWhen ended the run, and
    // without this the turn renders as a bare "Completed in N steps".
    const notice = stopNotice(
      DEFAULT_MAX_ITERATIONS,
      DEFAULT_MAX_ITERATIONS,
      "tool-calls",
    );
    expect(notice).toMatch(/step limit, not a length limit/);
    expect(notice).toContain(String(DEFAULT_MAX_ITERATIONS));
  });

  it("distinguishes a real output-limit truncation from the step limit", () => {
    const notice = stopNotice(2, DEFAULT_MAX_ITERATIONS, "length");
    expect(notice).toMatch(/output limit/);
    expect(notice).not.toMatch(/step limit/);
  });

  it("stays quiet below the cap", () => {
    expect(stopNotice(1, DEFAULT_MAX_ITERATIONS, "tool-calls")).toBe("");
    expect(stopNotice(0, DEFAULT_MAX_ITERATIONS, undefined)).toBe("");
  });
});
