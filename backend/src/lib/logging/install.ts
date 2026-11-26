// Composition-root wiring for structured logging. Called once by index.ts,
// worker.ts and workerThread.ts, right after ./telemetry and process guards;
// never by workerRuntime.ts (tests import it) or by tests. Must not import
// lib/supabase: the roots import tenantDebugStore.ts and start the poller.
import { AzureConsoleLogger } from "./azureConsoleLogger";
import { installConsoleBridge } from "./consoleBridge";
import { resetRootLoggerForTests, setRootLogger } from "./root";
import { TenantDebugSwitches } from "./tenantDebugSwitches";
import type { Clock, ILogger, LogFormat, LogLevel, LogProc, LogSink } from "./types";

export const systemClock: Clock = { now: () => Date.now() };

/** LOG_FORMAT wins; otherwise JSON in production and text elsewhere. */
export function logFormatFromEnv(env: NodeJS.ProcessEnv = process.env): LogFormat {
  const configured = env.LOG_FORMAT?.trim().toLowerCase();
  if (configured === "json" || configured === "text") return configured;
  return env.NODE_ENV === "production" ? "json" : "text";
}

/**
 * Writes each finished line through the console methods as they were before
 * the bridge (Application Insights' wrappers included): debug/info to stdout,
 * warn/error to stderr, one write per record.
 */
export function consoleSink(target: Console): LogSink {
  const out = target.log;
  const warn = target.warn;
  const error = target.error;
  return {
    write(level: LogLevel, line: string) {
      const method = level === "error" ? error : level === "warn" ? warn : out;
      method.call(target, line);
    },
  };
}

let installed: { logger: ILogger; debugSwitches: TenantDebugSwitches; uninstall(): void } | null = null;

export function installStructuredLogging(opts: { proc: LogProc; target?: Console; env?: NodeJS.ProcessEnv }):
  { logger: ILogger; debugSwitches: TenantDebugSwitches; uninstall(): void } {
  if (installed) return installed;
  const target = opts.target ?? console;
  const sink = consoleSink(target);
  let logger: ILogger | null = null;
  const debugSwitches = new TenantDebugSwitches({
    clock: systemClock,
    onChange: (tenantId, until) => {
      const untilIso = until ? until.toISOString() : null;
      logger?.with({ tenantId }).info("logging.debug_switch", { until: untilIso });
    },
    onError: (err) => logger?.warn("logging.debug_switch_read_failed", undefined, err),
  });
  logger = new AzureConsoleLogger({
    sink,
    clock: systemClock,
    debugGate: debugSwitches,
    proc: opts.proc,
    format: logFormatFromEnv(opts.env),
  });
  setRootLogger(logger);
  const uninstallBridge = installConsoleBridge(target, logger);
  const result = {
    logger,
    debugSwitches,
    uninstall() {
      uninstallBridge();
      debugSwitches.stop();
      resetRootLoggerForTests();
      installed = null;
    },
  };
  installed = result;
  return result;
}
