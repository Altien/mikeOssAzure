import { afterEach, describe, expect, it, vi } from "vitest";

const { streamTextMock } = vi.hoisted(() => ({
    streamTextMock: vi.fn((_options: unknown) => ({ stream: { async *[Symbol.asyncIterator]() {} } })),
}));
vi.mock("ai", () => ({
    streamText: streamTextMock,
    // Dev drift: the real provider model is wrapped with deadline middleware.
    wrapLanguageModel: ({ model }: { model: unknown }) => model,
    stepCountIs: (count: number) => ({ count }),
    jsonSchema: (schema: unknown) => schema,
    tool: (definition: unknown) => definition,
}));
import { streamAiSdk, DEFAULT_MAX_ITERATIONS, maxOutputTokensFor, stopNotice } from "./aiSdk";

describe("shared AI SDK step preparation", () => {
    it("composes the CourtListener reminder with final tool disablement and forwards abort", async () => {
        const abort = new AbortController();
        // Dev drift: since upstream #465 the SDK receives an internal signal
        // linked to the caller's, so assert forwarding while the stream runs.
        let forwardedWhileRunning: boolean | undefined;
        streamTextMock.mockImplementationOnce((opts: unknown) => {
            const signal = (opts as { abortSignal: AbortSignal }).abortSignal;
            abort.abort();
            forwardedWhileRunning = signal.aborted;
            return { stream: { async *[Symbol.asyncIterator]() {} } };
        });
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
            prepareStep: (args: { steps: Array<{ toolCalls: Array<{ toolName: string }> }> }) => Promise<Record<string, unknown>>;
        };
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        expect(forwardedWhileRunning).toBe(true);
        expect(options.stopWhen.count).toBe(2);
        // 016 awaits credit reservations in prepareStep before any provider request.
        expect(await options.prepareStep({ steps: [] })).toEqual({});
        expect(await options.prepareStep({ steps: [{ toolCalls: [{ toolName: "courtlistener_read_case" }] }] })).toMatchObject({
            activeTools: [], toolChoice: "none",
            system: expect.stringContaining("COURTLISTENER CITATION REMINDER"),
        });
    });
});

describe("continuing a reply cut off at the output limit", () => {
  type Part = Record<string, unknown> & { type: string };
  const usage = { inputTokens: 10, outputTokens: 5 };
  const step = (parts: Part[], finishReason: string): Part[] => [
    { type: "start-step" },
    ...parts,
    { type: "finish-step", finishReason, usage, response: { id: "r" } },
  ];
  const reply = (parts: Part[]) => ({
    stream: { async *[Symbol.asyncIterator]() { yield* parts; } },
    responseMessages: Promise.resolve([{ role: "assistant", content: "partial" }]),
  });
  const text = (value: string): Part => ({ type: "text-delta", text: value });
  const config = { provider: "openai" as const, label: "OpenAI", model: {} as never, modelId: "gpt-5.4" };

  async function run(replies: Part[][]) {
    streamTextMock.mockReset();
    for (const parts of replies) streamTextMock.mockImplementationOnce(() => reply(parts));
    const deltas: string[] = [];
    const meter = { observeOutput: vi.fn(), addStep: vi.fn(), beforeStep: vi.fn() };
    const result = await streamAiSdk({
      model: "gpt-5.4", systemPrompt: "Base", messages: [{ role: "user", content: "Draft it" }],
      callbacks: { onContentDelta: (delta) => deltas.push(delta) },
    }, config, meter as never);
    const calls = streamTextMock.mock.calls.map(([options]) => options as {
      messages: Array<{ role: string; content: unknown }>;
      activeTools?: unknown[];
      stopWhen: { count: number };
    });
    return { result, deltas, meter, calls };
  }

  it("joins a reply that stops for length and then finishes into one answer with no notice", async () => {
    const { result, deltas, meter, calls } = await run([
      step([text("Clause 1 ")], "length"),
      step([text("and Clause 2.")], "stop"),
    ]);
    expect(result.fullText).toBe("Clause 1 and Clause 2.");
    expect(deltas.join("")).toBe(result.fullText);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining("Continue exactly where you stopped"),
    });
    expect(calls[1]).toMatchObject({ activeTools: [], toolChoice: "none", stopWhen: { count: 1 } });
    expect(meter.addStep).toHaveBeenCalledTimes(2);
  });

  it("shows the notice once when the continuations run out", async () => {
    const { result, meter, calls } = await run([
      step([text("a")], "length"),
      step([text("b")], "length"),
      step([text("c")], "length"),
      step([text("d")], "length"),
    ]);
    expect(calls).toHaveLength(4);
    expect(result.fullText.startsWith("abcd")).toBe(true);
    expect(result.fullText.match(/output limit/g)).toHaveLength(1);
    expect(meter.addStep).toHaveBeenCalledTimes(4);
  });

  it("does not continue a reply cut off in the middle of a tool call", async () => {
    const { result, calls } = await run([
      step([text("Editing. "), { type: "tool-input-start", id: "t1", toolName: "edit" }], "length"),
    ]);
    expect(calls).toHaveLength(1);
    expect(result.fullText).toMatch(/output limit/);
  });

  it("keeps the reservation hooks on every continuation", async () => {
    streamTextMock.mockReset();
    streamTextMock
      .mockImplementationOnce(() => reply(step([text("a")], "length")))
      .mockImplementationOnce(() => reply(step([text("b")], "stop")));
    const meter = {
      observeOutput: vi.fn(), addStep: vi.fn(), beforeStep: vi.fn(),
      reservation: { maxOutputTokens: 100 },
    };
    await streamAiSdk({ model: "gpt-5.4", systemPrompt: "Base", messages: [] }, config, meter as never);
    const [first, second] = streamTextMock.mock.calls.map(([options]) => options as Record<string, unknown>);
    for (const key of ["prepareStep", "onStepFinish", "onChunk", "abortSignal", "maxOutputTokens", "maxRetries"]) {
      expect(second[key]).toBe(first[key]);
    }
    expect(second.maxOutputTokens).toBe(100);
  });
});

describe("maxOutputTokensFor", () => {
  afterEach(() => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
  });

  it("leaves the limit to the provider when unset", () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    expect(maxOutputTokensFor("claude")).toBeUndefined();
    expect(maxOutputTokensFor("gemini")).toBeUndefined();
  });

  it("keeps 16,384 for OpenCode Go, whose Messages models the Anthropic adapter would cap at 4,096", () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    expect(maxOutputTokensFor("opencode-go")).toBe(16_384);
  });

  it("leaves Kimi, TokenJuice, Meta and Azure OpenAI to the provider", () => {
    delete process.env.LLM_MAX_OUTPUT_TOKENS;
    expect(maxOutputTokensFor("kimi")).toBeUndefined();
    expect(maxOutputTokensFor("tokenjuice")).toBeUndefined();
    expect(maxOutputTokensFor("meta")).toBeUndefined();
    expect(maxOutputTokensFor("azureOpenai")).toBeUndefined();
  });

  it("uses an operator-set limit for every provider", () => {
    process.env.LLM_MAX_OUTPUT_TOKENS = "32000";
    expect(maxOutputTokensFor("claude")).toBe(32_000);
    expect(maxOutputTokensFor("opencode-go")).toBe(32_000);
  });

  it("ignores an unusable value rather than sending it upstream", () => {
    for (const value of ["", "0", "-1", "banana", "1.5"]) {
      process.env.LLM_MAX_OUTPUT_TOKENS = value;
      expect(maxOutputTokensFor("claude")).toBeUndefined();
    }
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
