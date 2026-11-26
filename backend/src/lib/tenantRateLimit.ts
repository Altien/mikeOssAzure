// Shared per-tenant rate limits (multi-tenant issue 017). A Postgres token
// bucket per (tenant, bucket), taken through take_tenant_rate_tokens
// (migration 0183) in one atomic statement, so the limit holds across every
// backend replica. The express-rate-limit limiters in app.ts stay as they
// are: per-IP abuse protection, not tenant fairness.
//
// Buckets:
//   requests      authenticated HTTP requests (middleware/auth.ts)
//   llm-requests  model calls (lib/llm/providers.ts, before the call)
//   llm-tokens    model tokens: checked before a call (denied while in debt)
//                 and debited with the call's actual input + output tokens
//                 when the usage ledger records it (lib/llm/usage.ts)
//
// Every limit is off unless configured (TENANT_REQUESTS_PER_MINUTE,
// TENANT_LLM_REQUESTS_PER_MINUTE, TENANT_LLM_TOKENS_PER_MINUTE), so
// single-tenant installs make no extra database call. Per-tenant values from
// the control plane's entitlements arrive with 014/016/018.
//
// The tenant comes from the ambient scope and reaches SQL as the PostgREST
// claim (002); work outside a tenant scope is never limited. A failing bucket
// call fails OPEN: the limiter must not take the product down with it.
import { UserFacingError, safeErrorLog } from "./safeError";
import { currentTenant } from "./tenantContext";
import { recordTenantMetric } from "./tenantMetrics";

export type TenantBucket = "requests" | "llm-requests" | "llm-tokens";

export type TenantRateLimits = {
  requestsPerMinute: number;
  llmRequestsPerMinute: number;
  llmTokensPerMinute: number;
};

function perMinute(env: NodeJS.ProcessEnv, name: string): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Configured limits; 0 means off. Read on every call so tests can stub env. */
export function tenantRateLimits(env: NodeJS.ProcessEnv = process.env): TenantRateLimits {
  return {
    requestsPerMinute: perMinute(env, "TENANT_REQUESTS_PER_MINUTE"),
    llmRequestsPerMinute: perMinute(env, "TENANT_LLM_REQUESTS_PER_MINUTE"),
    llmTokensPerMinute: perMinute(env, "TENANT_LLM_TOKENS_PER_MINUTE"),
  };
}

/** A tenant has used its share for now. Safe to show (a UserFacingError). */
export class TenantRateLimitError extends UserFacingError {
  readonly retryAfterMs: number;
  readonly bucket: TenantBucket;
  constructor(bucket: TenantBucket, retryAfterMs: number) {
    const seconds = retryAfterSeconds(retryAfterMs);
    super(
      `Your organisation has reached its usage rate limit. Please try again in about ${seconds} seconds.`,
    );
    this.name = "TenantRateLimitError";
    this.bucket = bucket;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Whole seconds for Retry-After and messages, at least 1, at most an hour. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.min(3600, Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

export type TakeResult = { allowed: boolean; retryAfterMs: number };

const ALLOWED: TakeResult = { allowed: true, retryAfterMs: 0 };
let lastWarnedAt = 0;

/**
 * Take `cost` from the current tenant's `bucket`, which holds `limitPerMinute`
 * tokens and refills continuously. `force` always debits (the bucket may go
 * negative) and reports allowed. No tenant scope or a limit of 0: allowed
 * without a database call.
 */
export async function takeTenantTokens(
  bucket: TenantBucket,
  cost: number,
  limitPerMinute: number,
  options: { force?: boolean } = {},
): Promise<TakeResult> {
  if (limitPerMinute <= 0 || !currentTenant()) return ALLOWED;
  try {
    // Loaded on first use, like the usage ledger, so LLM-only suites do not
    // pull the database client in.
    const { createServerSupabase } = await import("./supabase.js");
    const { data, error } = await createServerSupabase().rpc("take_tenant_rate_tokens", {
      p_bucket: bucket,
      p_cost: Math.max(0, cost),
      p_capacity: limitPerMinute,
      p_refill_per_second: limitPerMinute / 60,
      p_force: options.force === true,
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed?: boolean; retry_after_ms?: number }
      | null
      | undefined;
    if (!row || row.allowed !== false) return ALLOWED;
    return { allowed: false, retryAfterMs: Math.max(0, Number(row.retry_after_ms) || 0) };
  } catch (error) {
    recordTenantMetric("tenant.rate_limit_unavailable", { bucket });
    const now = Date.now();
    if (now - lastWarnedAt >= 60_000) {
      lastWarnedAt = now;
      console.warn("[tenant-rate-limit] bucket unavailable; allowing", safeErrorLog(error), { bucket });
    }
    return ALLOWED;
  }
}

/**
 * Admit one model call for the current tenant: one llm-requests token, and
 * the llm-tokens bucket must not be in debt. Throws TenantRateLimitError.
 */
export async function admitTenantLlmCall(
  limits: TenantRateLimits = tenantRateLimits(),
): Promise<void> {
  const requests = await takeTenantTokens("llm-requests", 1, limits.llmRequestsPerMinute);
  if (!requests.allowed) throw new TenantRateLimitError("llm-requests", requests.retryAfterMs);
  const tokens = await takeTenantTokens("llm-tokens", 0, limits.llmTokensPerMinute);
  if (!tokens.allowed) throw new TenantRateLimitError("llm-tokens", tokens.retryAfterMs);
}

/** Debit a finished call's tokens. Fire-and-forget; never throws. */
export function chargeTenantLlmTokens(
  tokens: number,
  limits: TenantRateLimits = tenantRateLimits(),
): Promise<void> {
  if (!(tokens > 0) || limits.llmTokensPerMinute <= 0) return Promise.resolve();
  return takeTenantTokens("llm-tokens", tokens, limits.llmTokensPerMinute, { force: true }).then(
    () => undefined,
  );
}
