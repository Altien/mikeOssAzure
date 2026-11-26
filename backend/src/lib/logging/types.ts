// Structured logging contracts (docs/structured-logging.md). Backend code
// depends on ILogger; the composition roots choose the implementation.
import type { ContextLight } from "./contextLight";
import type { DebugEventMap, DebugEventName } from "./debugEvents";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogProc = "api" | "worker" | "worker-thread";
export type LogFormat = "json" | "text";

/** Epoch milliseconds; injected so tests control `ts` and switch expiry. */
export interface Clock { now(): number }
/** One finished line per record; the sink never sees objects. */
export interface LogSink { write(level: LogLevel, line: string): void }
/** Synchronous per-record answer: is debug on for this tenant right now? */
export interface DebugGate { isOn(tenantId: string | undefined): boolean }
export type LogFields = Readonly<Record<string, unknown>>;

export interface SerializedError {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: SerializedError | string;
  errors?: Array<SerializedError | string>;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg?: string;
  event?: string;
  proc: LogProc;
  tenantId?: string;
  userId?: string;
  requestId?: string;
  chatId?: string;
  runId?: string;
  jobId?: string;
  data?: unknown;
  args?: unknown[];
  err?: SerializedError;
  src?: "console";
  truncated?: true;
}

export interface ILogger {
  debug<E extends DebugEventName>(event: E, fields: DebugEventMap[E]): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields, err?: unknown): void;
  error(msg: string, fields?: LogFields, err?: unknown): void;
  /** Bind context explicitly; bound fields win over ambient ones. */
  with(ctx: Partial<ContextLight>): ILogger;
  /** For gating expensive field assembly; same answer debug() would use. */
  debugEnabled(): boolean;
  /**
   * Bridge entry: already-positional console args, level from the method.
   * Unlike the other methods it may throw, so the bridge can fall back to
   * the original console method with the raw arguments.
   */
  console(level: LogLevel, args: readonly unknown[]): void;
}
