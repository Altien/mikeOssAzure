// ContextLight: the ids a log record carries (docs/structured-logging.md).
//
// A projection, not a third tenant store. Tenant and user come from
// lib/tenantContext (authoritative), the request id from lib/requestContext,
// and one small overlay store adds what neither knows (chat, run, job ids).
// Entering a log context never calls runWithTenant: the overlay grants no
// database authority. userEmail, roles and the tenant flags are never copied.
import { AsyncLocalStorage } from "node:async_hooks";
import { currentRequestId } from "../requestContext";
import { currentTenant } from "../tenantContext";

export interface ContextLight {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly requestId?: string;
  readonly chatId?: string;
  readonly runId?: string;
  readonly jobId?: string;
}

const KEYS = ["tenantId", "userId", "requestId", "chatId", "runId", "jobId"] as const;

const overlay = new AsyncLocalStorage<ContextLight>();

/** Only the six known keys, only non-empty strings. */
export function cleanContextLight(ctx: Partial<ContextLight> | undefined): ContextLight {
  const out: Record<string, string> = {};
  if (!ctx) return out;
  for (const key of KEYS) {
    const value = (ctx as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/** The ambient context for a record made now. Frozen. */
export function currentContextLight(): ContextLight {
  const tenant = currentTenant();
  const extra = overlay.getStore();
  const requestId = currentRequestId();
  // Precedence: tenant store (tenantId/userId), then overlay, then request id.
  const identity = tenant
    ? { tenantId: tenant.tenantId, userId: tenant.userId }
    : { tenantId: extra?.tenantId, userId: extra?.userId };
  return Object.freeze(cleanContextLight({ requestId, ...extra, ...identity }));
}

/** Run `fn` with extra ids on every record it (and what it awaits) makes. */
export function withLogContext<T>(extra: Partial<ContextLight>, fn: () => T): T {
  return overlay.run(Object.freeze({ ...overlay.getStore(), ...cleanContextLight(extra) }), fn);
}

/**
 * Add ids for the rest of the calling async function and everything it
 * awaits or schedules (AsyncLocalStorage.enterWith on the overlay only).
 * Used by the four assistant-turn routes after their claim, so the route
 * body is not re-indented. Prefer withLogContext wherever a wrapper is cheap.
 */
export function bindLogContext(extra: Partial<ContextLight>): void {
  overlay.enterWith(Object.freeze({ ...overlay.getStore(), ...cleanContextLight(extra) }));
}

/**
 * Explicit hand-off: run `fn` with exactly `ctx` as the overlay. Does not
 * open a tenant scope, so currentTenant() is unchanged.
 */
export function runWithContextLight<T>(ctx: ContextLight, fn: () => T): T {
  return overlay.run(Object.freeze(cleanContextLight(ctx)), fn);
}
