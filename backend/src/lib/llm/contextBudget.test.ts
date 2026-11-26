/**
 * The context budget: a request over the model's input budget is condensed
 * (old tool results shortened, then the oldest turns summarised) or refused
 * with a clear message, never sent to fail at the provider. No network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BudgetMessage,
  ContextTooLargeError,
  contextNotice,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  fitMessagesToBudget,
  inputBudgetFor,
  isContextLengthText,
  SHORTENED_TOOL_RESULT_CHARS,
  SUMMARY_SYSTEM_PROMPT,
} from "./contextBudget";

const big = (label: string, chars: number) => `${label} ${"x".repeat(chars)}`;

/** One tool round: the assistant's call and the tool's result. */
function toolRound(id: string, result: string): BudgetMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "read_document" }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: "read_document", output: { type: "text", value: result } },
      ],
    },
  ];
}

function fit(messages: BudgetMessage[], budget: number, summary = "S: the user asked about clause 4.") {
  const summarize = vi.fn(async () => summary);
  const result = fitMessagesToBudget({
    messages,
    fixedTokens: 100,
    budget,
    label: "Example AI",
    modelId: "example/small-model",
    summarize,
  });
  return { result, summarize };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inputBudgetFor", () => {
  it("uses a known family's window, else the environment setting, else the default", () => {
    expect(contextWindowFor("claude-sonnet-5-5")).toBe(200_000);
    expect(contextWindowFor("openrouter/google/gemini-3.8-flash")).toBe(1_048_576);
    expect(contextWindowFor("example/small-model")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    vi.stubEnv("LLM_CONTEXT_WINDOW_TOKENS", "230000");
    expect(contextWindowFor("example/small-model")).toBe(230_000);
    vi.stubEnv("LLM_CONTEXT_WINDOW_TOKENS", "lots");
    expect(contextWindowFor("example/small-model")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it("subtracts the output limit and a 10% margin", () => {
    vi.stubEnv("LLM_CONTEXT_WINDOW_TOKENS", "230000");
    expect(inputBudgetFor("example/small-model", 16_384)).toBe(230_000 - 16_384 - 23_000);
  });
});

describe("fitMessagesToBudget", () => {
  it("leaves a request under budget untouched", async () => {
    const messages: BudgetMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "question" },
    ];
    const { result, summarize } = fit(messages, 10_000);
    const fitted = await result;
    expect(fitted.messages).toBe(messages);
    expect(fitted).toMatchObject({ summarizedTurns: 0, shortenedToolResults: 0 });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("shortens earlier tool results first and keeps the latest whole", async () => {
    const messages: BudgetMessage[] = [
      { role: "user", content: "compare the two leases" },
      ...toolRound("a", big("lease A", 40_000)),
      ...toolRound("b", big("lease B", 8_000)),
    ];
    const { result, summarize } = fit(messages, 4_000);
    const fitted = await result;
    expect(summarize).not.toHaveBeenCalled();
    expect(fitted.shortenedToolResults).toBe(1);
    const [, call, first, , latest] = fitted.messages;
    // Each call still has its result, under the same id.
    expect(call).toBe(messages[1]);
    const firstPart = (first.content as unknown as Array<{ toolCallId: string; output: { value: string } }>)[0];
    expect(firstPart.toolCallId).toBe("a");
    expect(firstPart.output.value.startsWith("lease A")).toBe(true);
    expect(firstPart.output.value.length).toBeLessThan(SHORTENED_TOOL_RESULT_CHARS + 400);
    expect(firstPart.output.value).toContain("Shortened to fit the model's context window");
    expect(latest).toBe(messages[4]);
  });

  it("summarises the oldest turns, keeping recent turns verbatim and tool pairs together", async () => {
    const messages: BudgetMessage[] = [
      { role: "user", content: big("first question", 20_000) },
      { role: "assistant", content: big("first answer", 20_000) },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third question" },
      ...toolRound("c", "short lease text"),
    ];
    const { result, summarize } = fit(messages, 3_000);
    const fitted = await result;
    expect(summarize).toHaveBeenCalledOnce();
    const [request] = summarize.mock.calls[0] as unknown as [{ system: string; prompt: string }];
    expect(request.system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(request.prompt).toContain("User: first question");
    expect(request.prompt).not.toContain("second question");
    expect(fitted.summarizedTurns).toBe(1);
    expect(fitted.messages).toHaveLength(messages.length - 2);
    expect(fitted.messages[0].role).toBe("user");
    expect(fitted.messages[0].content).toContain("S: the user asked about clause 4.");
    expect(fitted.messages[0].content).toContain("second question");
    // Later turns, including the tool call and its result, are unchanged.
    expect(fitted.messages.slice(1)).toEqual(messages.slice(3));
  });

  it("refuses a request whose latest turn alone is over budget, with a clear message", async () => {
    const messages: BudgetMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "ok" },
      { role: "user", content: big("one enormous pasted contract", 80_000) },
    ];
    const { result, summarize } = fit(messages, 5_000);
    await expect(result).rejects.toBeInstanceOf(ContextTooLargeError);
    await expect(result).rejects.toThrow(
      /too large for Example AI \(example\/small-model\).*one document or one section at a time.*larger context window/,
    );
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("isContextLengthText", () => {
  it.each([
    "This model's maximum context length is 229376 tokens. However, you requested 240000 tokens.",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).",
  ])("recognises %s", (text) => {
    expect(isContextLengthText(text)).toBe(true);
  });

  it("ignores an unrelated rejection", () => {
    expect(isContextLengthText("Invalid tool schema")).toBe(false);
  });
});

describe("contextNotice", () => {
  it("says nothing when nothing was condensed, and names what was", () => {
    expect(contextNotice(0, 0)).toBe("");
    expect(contextNotice(1, 2)).toContain(
      "the earliest exchange in this conversation was replaced with a summary, and 2 long tool results from earlier steps were shortened after use",
    );
  });
});
