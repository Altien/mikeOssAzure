/**
 * Wiring of contextBudget.ts into streamAiSdk and toProviderStreamError:
 * the summary comes from the same model, the person is told, and a request
 * that cannot fit ends with the clear message. Stub model, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamAiSdk } from "./aiSdk";
import { toProviderStreamError } from "./providerErrors";
import { UserFacingError } from "../safeError";
import { config, makeModel, textStep } from "./__tests__/mockLanguageModel";

const big = (label: string, chars: number) => `${label} ${"x".repeat(chars)}`;

const generated = (summary: string) => ({
  content: [{ type: "text" as const, text: summary }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("streamAiSdk with a small context window", () => {
  it("condenses old turns with the same model and tells the person", async () => {
    vi.stubEnv("LLM_CONTEXT_WINDOW_TOKENS", "20000");
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "1000");
    const model = await makeModel([textStep("Clause 4 caps liability.")]);
    model.doGenerate = vi.fn(async () => generated("Earlier: the user uploaded a lease.")) as never;
    const deltas: string[] = [];
    const result = await streamAiSdk(
      {
        model: "mock-model",
        systemPrompt: "S",
        messages: [
          { role: "user", content: big("old question", 40_000) },
          { role: "assistant", content: big("old answer", 40_000) },
          { role: "user", content: "what does clause 4 say?" },
        ],
        callbacks: { onContentDelta: (d) => deltas.push(d) },
      },
      config(model),
    );
    expect(model.doGenerate).toHaveBeenCalledOnce();
    const sent = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(sent).not.toContain("old answer");
    expect(sent).toContain("Earlier: the user uploaded a lease.");
    expect(sent).toContain("what does clause 4 say?");
    expect(result.fullText).toMatch(
      /^Clause 4 caps liability\.\n\n_Condensed to fit this model's context window: the earliest exchange/,
    );
    expect(deltas.join("")).toBe(result.fullText);
  });

  it("ends the turn with the clear message, before any model call, when the latest turn cannot fit", async () => {
    vi.stubEnv("LLM_CONTEXT_WINDOW_TOKENS", "20000");
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "1000");
    const model = await makeModel([textStep("never")]);
    const run = streamAiSdk(
      {
        model: "mock-model",
        systemPrompt: "S",
        messages: [{ role: "user", content: big("pasted bundle", 200_000) }],
      },
      config(model),
    );
    await expect(run).rejects.toBeInstanceOf(UserFacingError);
    await expect(run).rejects.toThrow(/too large for Mock \(mock-model\)/);
    expect(model.doStreamCalls).toHaveLength(0);
  });
});

describe("toProviderStreamError for a context-length rejection", () => {
  const apiCallError = (statusCode: number, responseBody: string) =>
    Object.assign(new Error(`Request failed (${statusCode})`), { name: "AI_APICallError", statusCode, responseBody });
  const context = { label: "Example AI", modelId: "example/small-model" };

  it("shows the person the same clear message", () => {
    const original = apiCallError(
      400,
      '{"error":{"message":"This model\'s maximum context length is 229376 tokens.","code":"context_length_exceeded"}}',
    );
    const error = toProviderStreamError(original, context);
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error.message).toMatch(/too large for Example AI .*larger context window/);
    expect(error.cause).toBe(original);
  });

  it("leaves a per-minute token rate limit alone", () => {
    const error = toProviderStreamError(apiCallError(429, "Request too large: too many tokens per min"), context);
    expect(error.message).not.toMatch(/context window/);
  });
});
