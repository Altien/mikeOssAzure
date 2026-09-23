// Boot-failure and graceful-shutdown mechanics for the API entrypoint
// (src/index.ts). They live here, with their side effects injected, because
// index.ts starts a server and registers signal handlers at import time and
// so cannot be exercised by a unit test.

import { flushSentry, reportError } from "./observability/sentry";
import { safeErrorLog } from "./safeError";

export interface LifecycleEffects {
  report: typeof reportError;
  /** Operator-facing log line; the console bridge watches console.error. */
  logError: (...args: unknown[]) => void;
  logInfo: (...args: unknown[]) => void;
  flush: () => Promise<void>;
  exit: (code: number) => void;
}

export const processEffects: LifecycleEffects = {
  report: reportError,
  logError: (...args) => console.warn(...args),
  logInfo: (...args) => console.log(...args),
  flush: flushSentry,
  exit: (code) => process.exit(code),
};

/**
 * Report a boot failure once, tell the operator why, and exit 1.
 *
 * The Error OBJECT goes to console.error, not just its message. Sentry's
 * console bridge files every console.error as its own event and recognises
 * an error that reportError() already sent only by object identity; a
 * logged string is new text to it, so one failed boot used to arrive as two
 * issues ("Failure in boot" plus a context-free "Failure in application").
 */
export async function failBoot(
  err: unknown,
  stage: string,
  effects: LifecycleEffects = processEffects,
): Promise<void> {
  effects.report(err, { tags: { component: "boot", stage }, level: "fatal" });
  effects.logError("Mike backend failed to start:", safeErrorLog(err));
  await effects.flush();
  effects.exit(1);
}
