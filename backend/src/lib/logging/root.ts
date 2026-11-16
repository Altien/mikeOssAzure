// The process's root logger. Composition roots call setRootLogger() once;
// code calls log() (context read per record) or log().with(ctx). Until a root
// installs one, and in every test that does not opt in, it is a NullLogger, so
// debug calls never reach `console` and never disturb console spies.
import { NullLogger } from "./azureConsoleLogger";
import type { ILogger } from "./types";

const NULL_LOGGER: ILogger = new NullLogger();
let root: ILogger = NULL_LOGGER;

export function setRootLogger(logger: ILogger): void {
  root = logger;
}

export function log(): ILogger {
  return root;
}

export function resetRootLoggerForTests(): void {
  root = NULL_LOGGER;
}
