// Routes the existing console.* calls into the ILogger with the ambient
// ContextLight. Installed only at the composition roots (index.ts, worker.ts,
// workerThread.ts), never in tests or workerRuntime.ts.
//
// Patch order: Application Insights patches console at import (telemetry.ts),
// before this bridge; Sentry's captureConsoleIntegration wraps console.error
// in initSentry, after it. Records are written through the console methods
// captured here (see install.ts), so App Insights still sees every line, and
// Sentry still receives the raw arguments because it wraps the bridge.
import type { ILogger, LogLevel } from "./types";

const METHODS = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" } as const satisfies Record<string, LogLevel>;
type Method = keyof typeof METHODS;

export function installConsoleBridge(target: Console, logger: ILogger): () => void {
  const originals = {} as Record<Method, (...args: unknown[]) => void>;
  for (const method of Object.keys(METHODS) as Method[]) {
    const original = target[method] as (...args: unknown[]) => void;
    originals[method] = original;
    const level = METHODS[method];
    target[method] = function bridged(...args: unknown[]) {
      try {
        logger.console(level, args);
      } catch {
        // Never lose a line: the raw arguments, exactly as before the bridge.
        original.apply(target, args);
      }
    } as Console[Method];
  }
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    for (const method of Object.keys(originals) as Method[]) target[method] = originals[method] as Console[Method];
  };
}
