/**
 * Automatic continuation of a response cut off at the model's output limit.
 *
 * A step that finishes with reason "length" ends the AI SDK's step loop, so a
 * long answer simply stops mid-sentence. When the cut-off step was writing
 * plain text, the same model is asked to carry on from where it stopped and
 * the continuation is streamed into the same answer. The instruction is only
 * ever sent to the model; it never reaches the visible text.
 *
 * Provider-neutral: this module only looks at AI SDK stream part shapes and
 * passes message arrays through untouched.
 */

/**
 * Automatic continuations allowed per response. Each one is a full model call,
 * so a small bound keeps a runaway answer from multiplying its cost; after
 * that the caller's usual "stopped early" notice applies.
 */
export const MAX_LENGTH_CONTINUATIONS = 3;

export const CONTINUE_INSTRUCTION =
  "Continue exactly where you stopped. Do not repeat anything already written and do not add a preamble.";

export type LengthStopFacts = {
  finishReason: string | undefined;
  /** The step's last output was answer text (not reasoning or a tool call). */
  endedInText: boolean;
  /** The step started or made a tool call of its own. */
  toolCallInStep: boolean;
  continuationsUsed: number;
  maxContinuations: number;
};

/**
 * Whether a finished step should be continued automatically.
 *
 * Only a step that was cut off while writing text qualifies. A step cut off
 * inside a tool call has truncated arguments, and one cut off inside its
 * reasoning has no complete block to send back, so neither is resumed.
 */
export function shouldContinueAfterLength(facts: LengthStopFacts): boolean {
  return (
    facts.finishReason === "length" &&
    facts.endedInText &&
    !facts.toolCallInStep &&
    facts.continuationsUsed < facts.maxContinuations
  );
}

export type ContinueRequest = { role: "user"; content: string };

/** The conversation so far, the cut-off reply, and the request to go on. */
export function continuationMessages<M>(
  previous: readonly M[],
  response: readonly M[],
): Array<M | ContinueRequest> {
  return [...previous, ...response, { role: "user", content: CONTINUE_INSTRUCTION }];
}

/** The parts of an AI SDK `streamText` result this module reads. */
export type ContinuableStream<Part, M> = {
  stream: AsyncIterable<Part>;
  responseMessages: PromiseLike<M[]>;
};

type StreamPartShape = {
  type: string;
  text?: string;
  finishReason?: string;
  providerExecuted?: boolean;
};

/**
 * Yields every part of `first`, then of each continuation started while the
 * last step was cut off mid-text, as one stream. Each continuation is a new
 * call made by `startContinuation` with the full conversation so far, so the
 * caller's per-call hooks (usage, limits, abort) apply to it as usual.
 */
export async function* continueAfterLength<Part extends { type: string }, M>(
  first: ContinuableStream<Part, M>,
  startContinuation: (
    messages: Array<M | ContinueRequest>,
  ) => ContinuableStream<Part, M>,
  baseMessages: readonly M[],
  maxContinuations = MAX_LENGTH_CONTINUATIONS,
): AsyncGenerator<Part> {
  let current = first;
  let messages: Array<M | ContinueRequest> = [...baseMessages];
  for (let used = 0; ; used += 1) {
    let finishReason: string | undefined;
    let endedInText = false;
    let toolCallInStep = false;
    for await (const part of current.stream) {
      const p = part as StreamPartShape;
      switch (p.type) {
        case "start-step":
          finishReason = undefined;
          endedInText = false;
          toolCallInStep = false;
          break;
        case "text-delta":
          if (p.text) endedInText = true;
          break;
        case "reasoning-start":
        case "reasoning-delta":
          endedInText = false;
          break;
        case "tool-input-start":
        case "tool-call":
          endedInText = false;
          if (!p.providerExecuted) toolCallInStep = true;
          break;
        case "finish-step":
          finishReason = p.finishReason;
          break;
      }
      yield part;
    }
    if (
      !shouldContinueAfterLength({
        finishReason,
        endedInText,
        toolCallInStep,
        continuationsUsed: used,
        maxContinuations,
      })
    ) {
      return;
    }
    const response = await current.responseMessages;
    messages = continuationMessages<M | ContinueRequest>(messages, response);
    current = startContinuation(messages);
  }
}
