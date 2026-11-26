// The reviewed allow-list of debug events (docs/structured-logging.md).
//
// Adding an event or a field means editing THIS file; that is the review
// point. Field values are ids, counts, durations, booleans or static
// identifiers only — never prompt, answer, document or error-message text.
// At runtime every string must match DEBUG_TOKEN_PATTERN or it is replaced
// with "[redacted]"; arrays and objects are always redacted (log a count).
// A unit test scans the field names below for content-like words.

/** An id, model/tool name, finish reason or error category. */
export type DebugToken = string;
type Tok = DebugToken | null | undefined;
type Num = number | null | undefined;
type Bool = boolean | null | undefined;

export interface DebugEventMap {
  "llm.call.start": { model: Tok; provider: Tok; maxIterations: Num; maxOutputTokens: Num; inputBudget: Num; toolCount: Num; reasoning: Tok; metered: Bool };
  "llm.step.finish": { model: Tok; step: Num; inputTokens: Num; outputTokens: Num; finishReason: Tok; rawFinishReason: Tok };
  "llm.call.finish": { model: Tok; steps: Num; finishReason: Tok; planningRestarts: Num; summarizedTurns: Num; shortenedToolResults: Num; outputChars: Num; durationMs: Num };
  "llm.provider_error": { model: Tok; provider: Tok; errorType: Tok; failureKind: Tok; httpStatus: Num; toolFailure: Bool };
  "llm.stream_abort": { model: Tok; stalled: Bool; callerAborted: Bool };
  "llm.deadline_fired": { model: Tok; provider: Tok; which: "first_chunk" | "chunk"; limitMs: Num };
  "llm.length_followup": { kind: "continue" | "recover"; used: Num; max: Num; finishReason: Tok; endedWriting: Bool; toolCallInStep: Bool };
  "llm.context_fit": { model: Tok; budget: Num; fixedTokens: Num; totalTokens: Num; shortenedToolResults: Num; summarizedTurns: Num };
  "tool.call": { toolName: Tok; toolCallId: Tok; durationMs: Num; outcome: "ok" | "error"; subagent: Bool };
  "doc.edit": { documentId: Tok; edits: Num; ok: Bool; versionId: Tok; versionNumber: Num };
  "doc.generate": { sections: Num; landscape: Bool; numberSections: Bool; documentId: Tok };
  "delegate.start": { delegationId: Tok; continuedFrom: Tok; model: Tok; effort: Tok; tier: Tok; maxSteps: Num; timeoutMs: Num; documents: Num };
  "delegate.finish": { delegationId: Tok; status: Tok; stopReason: Tok; inputTokens: Num; outputTokens: Num; records: Num; errorCategory: Tok };
  "turn.claim": { surface: Tok; claimed: Bool };
  "streamrun.claim": { surface: Tok; claimed: Bool };
  "streamrun.finish": { surface: Tok; seq: Num; stopReason: Tok; durationMs: Num; bufferedBytes: Num; bufferExhausted: Bool };
  "streamrun.stop": { reason: Tok; seq: Num };
  "streamrun.owner_lost": { cause: "advertise_invalid" | "advertise_failed" | "renew_lost" | "renew_failed"; seq: Num };
  "relay.page_fetch_fail": { failures: Num; ownerInstance: Tok; cursor: Num };
  "relay.dispatch": { op: Tok; ok: Bool };
  "conversion.job": { documentId: Tok; versionId: Tok; finalize: Bool; outcome: "start" | "converted" | "convert_failed"; pdfBytes: Num; errorCategory: Tok };
  "upload.job": { uploadJobId: Tok; attempts: Num; sessionId: Tok; purpose: Tok; format: Tok; outcome: Tok; durationMs: Num };
  "dbq.job": { jobKind: Tok; attempts: Num; maxAttempts: Num; phase: "start" | "done" | "retry" | "defer" | "failed"; delayMs: Num; leaseLost: Bool };
}

export type DebugEventName = keyof DebugEventMap;

export const DEBUG_TOKEN_PATTERN = /^[A-Za-z0-9._:/@+=-]{0,128}$/;
export const REDACTED = "[redacted]";

/**
 * Runtime half of the allow-list: the types above stop content at compile
 * time, this stops it when a call site passes something it should not.
 */
export function sanitizeDebugFields(fields: unknown): Record<string, number | boolean | string | null> {
  const out: Record<string, number | boolean | string | null> = {};
  if (!fields || typeof fields !== "object") return out;
  for (const key of Object.keys(fields)) {
    let value: unknown;
    try {
      value = (fields as Record<string, unknown>)[key];
    } catch {
      out[key] = REDACTED;
      continue;
    }
    if (value === undefined) continue;
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") out[key] = DEBUG_TOKEN_PATTERN.test(value) ? value : REDACTED;
    else out[key] = REDACTED;
  }
  return out;
}
