import { markReportedLog, reportError, type ReportContext } from "../observability/sentry";
import { safeErrorLog } from "../safeError";
import { providerFailureLevel } from "./providerErrors";

/** Preserve the failure and its context; the final transport samples repeats. */
export function reportModelFailure(failure: Error, context: ReportContext, logLabel: string): void {
  reportError(failure, { ...context, level: providerFailureLevel(failure) });
  // Dev divergence (sync-log: 2ada45fb): Dev logs a sanitized copy, marked as
  // the already reported failure so the console bridge does not file it twice.
  console.error(logLabel, markReportedLog(safeErrorLog(failure)));
}
