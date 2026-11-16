// JSON-safe serialisation for log records (docs/structured-logging.md,
// "Record format"). Nothing here throws on odd input: getters that throw,
// cycles, bigint, buffers and deep graphs all become placeholders.
import { redactSensitiveText } from "../safeError";
import type { LogRecord, SerializedError } from "./types";

export const MAX_STRING_CHARS = 2_000;
export const MAX_STACK_CHARS = 4_000;
export const MAX_DEPTH = 4;
export const MAX_ARRAY_ITEMS = 20;
export const MAX_AGGREGATE_ERRORS = 5;
export const MAX_LINE_BYTES = 16_000;

const REDACTED_KEYS = new Set([
  "content", "text", "prompt", "messages", "body", "answer",
  "document", "email", "useremail", "authorization", "password", "token",
]);

export function capString(value: string, max = MAX_STRING_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

/** Secret redaction plus the length cap, for every free-text string. */
export function safeText(value: string, max = MAX_STRING_CHARS): string {
  // Bound the regex work on huge strings, with slack so a secret straddling
  // the cut is still matched whole before the final cap.
  const bounded = value.length > max + 512 ? value.slice(0, max + 512) : value;
  return capString(redactSensitiveText(bounded), max);
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error;
}

/** `{ name, message, code?, stack?, cause? }`, one level of cause. */
export function serializeError(error: unknown, withCause = true): SerializedError {
  if (!isErrorLike(error)) {
    return { name: "NonError", message: safeText(stringify(error)) };
  }
  const out: SerializedError = {
    name: safeText(String(read(error, "name") ?? "Error"), 200),
    message: safeText(String(read(error, "message") ?? "")),
  };
  const code = read(error, "code");
  if (typeof code === "string" || typeof code === "number") out.code = typeof code === "string" ? capString(code, 200) : code;
  const stack = read(error, "stack");
  if (typeof stack === "string") out.stack = safeText(stack, MAX_STACK_CHARS);
  const cause = read(error, "cause");
  if (withCause && cause !== undefined) {
    out.cause = isErrorLike(cause) ? serializeError(cause, false) : safeText(stringify(cause));
  }
  const errors = read(error, "errors");
  if (error instanceof AggregateError && Array.isArray(errors)) {
    out.errors = errors.slice(0, MAX_AGGREGATE_ERRORS).map((inner) =>
      isErrorLike(inner) ? serializeError(inner, false) : safeText(stringify(inner)));
  }
  return out;
}

function read(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return "[unreadable]";
  }
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "[unprintable]";
  }
}

/**
 * A JSON-safe copy of `value`: depth ≤ 4, arrays ≤ 20 items, bigint as a
 * string, cycles as "[circular]", functions and symbols dropped, binary as
 * "[binary N bytes]". With `redactKeys`, content-bearing keys (see
 * REDACTED_KEYS, case-insensitive) become "[redacted]".
 */
export function serializeValue(value: unknown, redactKeys = true): unknown {
  return walk(value, 0, new Set<object>(), redactKeys);
}

function walk(value: unknown, depth: number, ancestors: Set<object>, redactKeys: boolean): unknown {
  switch (typeof value) {
    case "string": return safeText(value);
    case "number": return Number.isFinite(value) ? value : String(value);
    case "boolean": return value;
    case "bigint": return value.toString();
    case "undefined": case "function": case "symbol": return undefined;
  }
  if (value === null) return null;
  const obj = value as object;
  if (isErrorLike(obj)) return serializeError(obj);
  if (Buffer.isBuffer(obj) || ArrayBuffer.isView(obj)) return `[binary ${(obj as ArrayBufferView).byteLength} bytes]`;
  if (obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof Map) return `[Map ${obj.size}]`;
  if (obj instanceof Set) return `[Set ${obj.size}]`;
  if (ancestors.has(obj)) return "[circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? "[array]" : "[object]";
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY_ITEMS).map((item) => {
        const out = walk(item, depth + 1, ancestors, redactKeys);
        return out === undefined ? null : out;
      });
      if (obj.length > MAX_ARRAY_ITEMS) items.push(`[${obj.length - MAX_ARRAY_ITEMS} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (redactKeys && REDACTED_KEYS.has(key.toLowerCase())) {
        out[key] = "[redacted]";
        continue;
      }
      const item = walk(read(obj, key), depth + 1, ancestors, redactKeys);
      if (item !== undefined) out[key] = item;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * The record as one JSON line of at most 16,000 bytes (containerd splits
 * longer lines, which breaks parse_json). Over the cap: drop `args`, then
 * `data`, then trim `err.stack`, then `msg`; mark `truncated: true`.
 */
export function capRecord(record: LogRecord, render: (r: LogRecord) => string = JSON.stringify): string {
  let line = render(record);
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const r: LogRecord = { ...record, truncated: true };
  const steps: Array<() => void> = [
    () => { delete r.args; },
    () => { delete r.data; },
    () => { if (r.err) r.err = { ...r.err, stack: r.err.stack ? capString(r.err.stack, 1_000) : undefined }; },
    () => { if (r.msg) r.msg = capString(r.msg, 500); },
    () => { if (r.err) r.err = { name: r.err.name, message: capString(r.err.message, 500) }; },
    () => { delete r.err; },
  ];
  for (const step of steps) {
    step();
    line = render(r);
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  }
  // Ids and msg are bounded, so this only fires on pathological input.
  return render({ ts: r.ts, level: r.level, proc: r.proc, msg: "[log record too large]", truncated: true });
}
