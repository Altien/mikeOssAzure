// The HTTP request id (X-Request-ID, minted in app.ts) for code that runs
// deep inside a request without `res` in reach — the LLM usage ledger records
// it (multi-tenant issue 015). Best effort: work started outside a request
// (jobs, sweeps) has none, and app.ts enters the scope after the body parsers
// so their stream callbacks do not drop it.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(requestId: string | undefined, fn: () => T): T {
  return requestId ? storage.run(requestId, fn) : fn();
}

export function currentRequestId(): string | undefined {
  return storage.getStore();
}
