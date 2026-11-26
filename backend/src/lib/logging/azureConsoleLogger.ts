// AzureConsoleLogger: one JSON line per record on stdout/stderr, which Azure
// Container Apps ships to Log Analytics (ContainerAppConsoleLogs_CL.Log_s).
// See docs/structured-logging.md for the record format.
import { cleanContextLight, currentContextLight, type ContextLight } from "./contextLight";
import { sanitizeDebugFields, type DebugEventMap, type DebugEventName } from "./debugEvents";
import { capRecord, safeText, serializeError, serializeValue } from "./serialize";
import type { Clock, DebugGate, ILogger, LogFields, LogFormat, LogLevel, LogProc, LogRecord, LogSink } from "./types";

export interface AzureConsoleLoggerDeps {
  sink: LogSink;
  clock: Clock;
  debugGate: DebugGate;
  proc: LogProc;
  format?: LogFormat;
  bound?: Partial<ContextLight>;
}

export class AzureConsoleLogger implements ILogger {
  private readonly bound: ContextLight;

  constructor(private readonly deps: AzureConsoleLoggerDeps) {
    this.bound = cleanContextLight(deps.bound);
  }

  debug<E extends DebugEventName>(event: E, fields: DebugEventMap[E]): void {
    try {
      const ctx = this.context();
      if (!this.deps.debugGate.isOn(ctx.tenantId)) return;
      this.emit({ ...this.base("debug", ctx), event, data: sanitizeDebugFields(fields) });
    } catch {
      /* logging never throws into the caller */
    }
  }

  info(msg: string, fields?: LogFields): void {
    this.plain("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields, err?: unknown): void {
    this.plain("warn", msg, fields, err);
  }

  error(msg: string, fields?: LogFields, err?: unknown): void {
    this.plain("error", msg, fields, err);
  }

  with(ctx: Partial<ContextLight>): ILogger {
    return new AzureConsoleLogger({ ...this.deps, bound: { ...this.bound, ...cleanContextLight(ctx) } });
  }

  debugEnabled(): boolean {
    try {
      return this.deps.debugGate.isOn(this.context().tenantId);
    } catch {
      return false;
    }
  }

  console(level: LogLevel, args: readonly unknown[]): void {
    const ctx = this.context();
    if (level === "debug" && !this.deps.debugGate.isOn(ctx.tenantId)) return;
    const rest = [...args];
    const msg = typeof rest[0] === "string" ? (rest.shift() as string) : "";
    // The first Error argument becomes `err`, so it survives the size cap.
    const errIndex = rest.findIndex((arg) => arg instanceof Error);
    const err = errIndex >= 0 ? rest.splice(errIndex, 1)[0] : undefined;
    const record: LogRecord = { ...this.base(level, ctx), msg: safeText(msg) };
    if (rest.length) record.args = serializeValue(rest) as unknown[];
    if (err !== undefined) record.err = serializeError(err);
    record.src = "console";
    this.deps.sink.write(level, this.render(record));
  }

  private plain(level: LogLevel, msg: string, fields?: LogFields, err?: unknown): void {
    try {
      const record: LogRecord = { ...this.base(level, this.context()), msg: safeText(String(msg)) };
      if (fields && Object.keys(fields).length) record.data = serializeValue(fields);
      if (err !== undefined) record.err = serializeError(err);
      this.emit(record);
    } catch {
      /* logging never throws into the caller */
    }
  }

  private context(): ContextLight {
    return { ...currentContextLight(), ...this.bound };
  }

  private base(level: LogLevel, ctx: ContextLight): LogRecord {
    return { ts: new Date(this.deps.clock.now()).toISOString(), level, proc: this.deps.proc, ...ctx };
  }

  private emit(record: LogRecord): void {
    this.deps.sink.write(record.level, this.render(record));
  }

  private render(record: LogRecord): string {
    return capRecord(record, this.deps.format === "text" ? renderText : JSON.stringify);
  }
}

/** `ts level [tenant/user] msg {rest}` for local development. */
function renderText(record: LogRecord): string {
  const { ts, level, tenantId, userId, msg, event, proc: _proc, err, ...rest } = record;
  const who = tenantId || userId ? ` [${tenantId ?? "-"}/${userId ?? "-"}]` : "";
  const head = `${ts} ${level.toUpperCase()}${who} ${event ?? msg ?? ""}`;
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  const errText = err ? ` ${err.stack ?? `${err.name}: ${err.message}`}` : "";
  return `${head}${extra}${errText}`;
}

/** Discards everything: the root logger until a composition root installs one. */
export class NullLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  with(): ILogger { return this; }
  debugEnabled(): boolean { return false; }
  console(): void {}
}

/** In-memory sink for tests. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  readonly levels: LogLevel[] = [];

  write(level: LogLevel, line: string): void {
    this.levels.push(level);
    this.lines.push(line);
  }

  records(): LogRecord[] {
    return this.lines.map((line) => JSON.parse(line) as LogRecord);
  }
}
