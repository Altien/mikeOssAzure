/**
 * Automatic continuation of a response cut off at the model's output limit.
 *
 * A step that finishes with reason "length" ends the AI SDK's step loop, so a
 * long answer simply stops mid-sentence. When the cut-off step was writing
 * plain text, the same model is asked to carry on from where it stopped and
 * the continuation is streamed into the same answer. The instruction is only
 * ever sent to the model; it never reaches the visible text.
 *
 * A step cut off while still reasoning, before writing any answer text, is
 * recovered instead: its incomplete reasoning cannot be replayed safely (it
 * may be unsigned or truncated), so the step is dropped and the model is asked
 * to write the answer now. Earlier, completed steps (tool calls and their
 * results) are kept, so nothing already read is lost.
 *
 * Provider-neutral: this module only looks at AI SDK stream part shapes and
 * passes message arrays through, apart from dropping a cut-off step.
 */

/**
 * Automatic continuations and recoveries allowed per response, together.
 * Each one is a full model call, so a small bound keeps a runaway answer from
 * multiplying its cost; after that the caller's usual "stopped early" notice
 * applies.
 */
export const MAX_LENGTH_CONTINUATIONS = 3;

export const CONTINUE_INSTRUCTION =
  "Continue exactly where you stopped. Do not repeat anything already written and do not add a preamble.";

export const RECOVER_INSTRUCTION =
  "You ran out of output space while still planning and wrote no answer. Do not plan at length again. Write the answer now, starting with the most important part. If it will not fit in one reply, write the first part in full and say what remains.";

/** Shown under an answer that needed at least one recovery. */
export function planningRestartNotice(recoveries: number): string {
  return recoveries > 0
    ? "\n\n_Mike ran out of room while planning this answer and restarted it more directly._"
    : "";
}

export type LengthStopFacts = {
  finishReason: string | undefined;
  /** The step's last output was answer text (not reasoning or a tool call). */
  endedInText: boolean;
  /** The step wrote any answer text at all. */
  textInStep: boolean;
  /** The step started or made a tool call of its own. */
  toolCallInStep: boolean;
  continuationsUsed: number;
  maxContinuations: number;
};

/** How a cut-off step is carried on: resumed mid-text, or restarted. */
export type LengthFollowUp = "continue" | "recover";

/**
 * Whether a finished step should be continued automatically.
 *
 * Only a step that was cut off while writing text qualifies. A step cut off
 * inside a tool call has truncated arguments, and one cut off inside its
 * reasoning has no complete block to send back, so neither is resumed. (A
 * step that wrote nothing at all is restarted instead; see
 * `shouldRecoverAfterLength`.)
 */
export function shouldContinueAfterLength(facts: LengthStopFacts): boolean {
  return (
    facts.finishReason === "length" &&
    facts.endedInText &&
    !facts.toolCallInStep &&
    facts.continuationsUsed < facts.maxContinuations
  );
}

/**
 * Whether a finished step should be restarted because it spent the whole
 * output allowance before writing anything: no answer text and no tool call
 * of its own, typically a model still reasoning. Shares the bound with
 * continuations.
 */
export function shouldRecoverAfterLength(facts: LengthStopFacts): boolean {
  return (
    facts.finishReason === "length" &&
    !facts.textInStep &&
    !facts.toolCallInStep &&
    facts.continuationsUsed < facts.maxContinuations
  );
}

/** What to do after a finished step, or undefined to stop. */
export function lengthFollowUp(facts: LengthStopFacts): LengthFollowUp | undefined {
  if (shouldContinueAfterLength(facts)) return "continue";
  if (shouldRecoverAfterLength(facts)) return "recover";
  return undefined;
}

/**
 * The reasoning level for a recovery call: the lowest level the model
 * supports that still has reasoning on, when that is lower than the current
 * one. Reasoning is never switched on or off (some providers reject toggling
 * it in the middle of a tool loop), and an unknown level is left alone.
 *
 * `supported` lists the model's levels from lowest to highest.
 */
export function recoveryReasoningLevel<L>(
  current: L | undefined,
  supported: readonly L[],
  off: L,
): L | undefined {
  if (current === undefined || current === off) return current;
  const lowest = supported.find((level) => level !== off);
  const currentIndex = supported.indexOf(current);
  if (lowest === undefined || currentIndex === -1) return current;
  return currentIndex > supported.indexOf(lowest) ? lowest : current;
}

export type ContinueRequest = { role: "user"; content: string };

/** The conversation so far, the cut-off reply, and the request to go on. */
export function continuationMessages<M>(
  previous: readonly M[],
  response: readonly M[],
): Array<M | ContinueRequest> {
  return [...previous, ...response, { role: "user", content: CONTINUE_INSTRUCTION }];
}

/**
 * The conversation so far, the completed steps of the cut-off reply, and the
 * request to answer now.
 *
 * A step that made no tool call of its own adds at most one message, the
 * assistant message with its output, and adds none when it had no output. The
 * step before it, if any, made tool calls and so ended with their results.
 * So a trailing assistant message is exactly the cut-off step, and dropping
 * it whole (rather than only its reasoning) also drops any provider-run tool
 * parts that some providers refuse without their reasoning item.
 */
export function recoveryMessages<M extends { role: string }>(
  previous: readonly M[],
  response: readonly M[],
): Array<M | ContinueRequest> {
  const completed = response.at(-1)?.role === "assistant" ? response.slice(0, -1) : response;
  return [...previous, ...completed, { role: "user", content: RECOVER_INSTRUCTION }];
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
 * Yields every part of `first`, then of each follow-up call, as one stream.
 * A step cut off mid-text is continued; one cut off before writing anything
 * is recovered (see `recoveryMessages`). Each follow-up is a new call made by
 * `startFollowUp` with the conversation so far, so the caller's per-call hooks
 * (usage, limits, abort) apply to it as usual. The caller decides what a
 * recovery call may do (tools, reasoning) from `kind`.
 */
export async function* continueAfterLength<Part extends { type: string }, M extends { role: string }>(
  first: ContinuableStream<Part, M>,
  startFollowUp: (
    messages: Array<M | ContinueRequest>,
    kind: LengthFollowUp,
  ) => ContinuableStream<Part, M>,
  baseMessages: readonly M[],
  maxContinuations = MAX_LENGTH_CONTINUATIONS,
): AsyncGenerator<Part> {
  let current = first;
  let messages: Array<M | ContinueRequest> = [...baseMessages];
  for (let used = 0; ; used += 1) {
    let finishReason: string | undefined;
    let endedInText = false;
    let textInStep = false;
    let toolCallInStep = false;
    for await (const part of current.stream) {
      const p = part as StreamPartShape;
      switch (p.type) {
        case "start-step":
          finishReason = undefined;
          endedInText = false;
          textInStep = false;
          toolCallInStep = false;
          break;
        case "text-delta":
          if (p.text) {
            endedInText = true;
            textInStep = true;
          }
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
    const kind = lengthFollowUp({
      finishReason,
      endedInText,
      textInStep,
      toolCallInStep,
      continuationsUsed: used,
      maxContinuations,
    });
    if (!kind) return;
    const response = await current.responseMessages;
    messages = kind === "continue"
      ? continuationMessages<M | ContinueRequest>(messages, response)
      : recoveryMessages<M | ContinueRequest>(messages, response);
    current = startFollowUp(messages, kind);
  }
}
