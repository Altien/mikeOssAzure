import { describe, expect, it } from "vitest";
import {
  CONTINUE_INSTRUCTION,
  MAX_LENGTH_CONTINUATIONS,
  continueAfterLength,
  continuationMessages,
  shouldContinueAfterLength,
  type ContinuableStream,
} from "./lengthContinuation";

type Part = { type: string; text?: string; finishReason?: string; providerExecuted?: boolean };
type Message = { role: string; content: unknown };

const cutOff = {
  finishReason: "length",
  endedInText: true,
  toolCallInStep: false,
  continuationsUsed: 0,
  maxContinuations: MAX_LENGTH_CONTINUATIONS,
};

describe("shouldContinueAfterLength", () => {
  it("continues text cut off at the output limit", () => {
    expect(shouldContinueAfterLength(cutOff)).toBe(true);
  });

  it("leaves a finished answer alone", () => {
    expect(shouldContinueAfterLength({ ...cutOff, finishReason: "stop" })).toBe(false);
    expect(shouldContinueAfterLength({ ...cutOff, finishReason: "tool-calls" })).toBe(false);
    expect(shouldContinueAfterLength({ ...cutOff, finishReason: undefined })).toBe(false);
  });

  it("does not resume a step cut off inside a tool call or its reasoning", () => {
    expect(shouldContinueAfterLength({ ...cutOff, toolCallInStep: true })).toBe(false);
    expect(shouldContinueAfterLength({ ...cutOff, endedInText: false })).toBe(false);
  });

  it("stops once the continuations are used up", () => {
    expect(shouldContinueAfterLength({ ...cutOff, continuationsUsed: MAX_LENGTH_CONTINUATIONS - 1 })).toBe(true);
    expect(shouldContinueAfterLength({ ...cutOff, continuationsUsed: MAX_LENGTH_CONTINUATIONS })).toBe(false);
  });
});

describe("continuationMessages", () => {
  it("appends the cut-off reply and the request to go on", () => {
    const previous = [{ role: "user", content: "Draft it" }];
    const response = [{ role: "assistant", content: [{ type: "text", text: "Clause 1" }] }];
    expect(continuationMessages(previous, response)).toEqual([
      ...previous,
      ...response,
      { role: "user", content: CONTINUE_INSTRUCTION },
    ]);
  });
});

function call(parts: Part[], response: Message[] = []): ContinuableStream<Part, Message> {
  return {
    stream: { async *[Symbol.asyncIterator]() { yield* parts; } },
    responseMessages: Promise.resolve(response),
  };
}

const textStep = (text: string, finishReason: string): Part[] => [
  { type: "start-step" },
  { type: "text-delta", text },
  { type: "finish-step", finishReason },
];

async function collect(stream: AsyncIterable<Part>): Promise<Part[]> {
  const parts: Part[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("continueAfterLength", () => {
  it("streams the continuation after the cut-off reply and sends the whole conversation", async () => {
    const requests: unknown[][] = [];
    const reply = { role: "assistant", content: "Clause 1, " };
    const parts = await collect(continueAfterLength(
      call(textStep("Clause 1, ", "length"), [reply]),
      (messages) => {
        requests.push(messages);
        return call(textStep("Clause 2.", "stop"));
      },
      [{ role: "user", content: "Draft it" }],
    ));
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.text).join("")).toBe("Clause 1, Clause 2.");
    expect(requests).toEqual([[
      { role: "user", content: "Draft it" },
      reply,
      { role: "user", content: CONTINUE_INSTRUCTION },
    ]]);
  });

  it("makes at most the allowed number of continuations", async () => {
    let calls = 0;
    const parts = await collect(continueAfterLength(
      call(textStep("a", "length")),
      () => {
        calls += 1;
        return call(textStep("b", "length"));
      },
      [],
      2,
    ));
    expect(calls).toBe(2);
    expect(parts.at(-1)).toMatchObject({ type: "finish-step", finishReason: "length" });
  });

  it("does not continue a step cut off inside a tool call", async () => {
    let calls = 0;
    await collect(continueAfterLength(
      call([
        { type: "start-step" },
        { type: "text-delta", text: "Editing now." },
        { type: "tool-input-start" },
        { type: "finish-step", finishReason: "length" },
      ]),
      () => {
        calls += 1;
        return call([]);
      },
      [],
    ));
    expect(calls).toBe(0);
  });

  it("does not continue a step cut off in its reasoning", async () => {
    let calls = 0;
    await collect(continueAfterLength(
      call([
        { type: "start-step" },
        { type: "text-delta", text: "Draft" },
        { type: "reasoning-delta", text: "thinking" },
        { type: "finish-step", finishReason: "length" },
      ]),
      () => {
        calls += 1;
        return call([]);
      },
      [],
    ));
    expect(calls).toBe(0);
  });

  it("continues text written after a provider-run tool finished", async () => {
    let calls = 0;
    await collect(continueAfterLength(
      call([
        { type: "start-step" },
        { type: "tool-input-start", providerExecuted: true },
        { type: "tool-call", providerExecuted: true },
        { type: "text-delta", text: "Per the search, " },
        { type: "finish-step", finishReason: "length" },
      ]),
      () => {
        calls += 1;
        return call(textStep("done.", "stop"));
      },
      [],
    ));
    expect(calls).toBe(1);
  });
});
