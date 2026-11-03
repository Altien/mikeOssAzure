// Multi-tenant 017: shared per-tenant token buckets (migration 0183).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../supabase", () => ({ createServerSupabase: () => ({ rpc }) }));

import { runWithTenant } from "../tenantContext";
import {
  TenantRateLimitError,
  admitTenantLlmCall,
  chargeTenantLlmTokens,
  takeTenantTokens,
  tenantRateLimits,
} from "../tenantRateLimit";
import { UserFacingError } from "../safeError";
import { tenantMetricCount } from "../tenantMetrics";

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ tenantId: "tenant-a", userId: "u" }, fn);

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [{ allowed: true, remaining: 1, retry_after_ms: 0 }], error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("tenant rate limits", () => {
  it("are all off by default", () => {
    expect(tenantRateLimits({})).toEqual({ requestsPerMinute: 0, llmRequestsPerMinute: 0, llmTokensPerMinute: 0 });
    expect(
      tenantRateLimits({
        TENANT_REQUESTS_PER_MINUTE: "600",
        TENANT_LLM_REQUESTS_PER_MINUTE: "60",
        TENANT_LLM_TOKENS_PER_MINUTE: "bad",
      }),
    ).toEqual({ requestsPerMinute: 600, llmRequestsPerMinute: 60, llmTokensPerMinute: 0 });
  });

  it("makes no database call when the limit is off or there is no tenant", async () => {
    await expect(inTenant(() => takeTenantTokens("requests", 1, 0))).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await expect(takeTenantTokens("requests", 1, 60)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    await inTenant(() => admitTenantLlmCall());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("takes from the tenant's bucket with a per-second refill", async () => {
    await inTenant(() => takeTenantTokens("requests", 1, 120));
    expect(rpc).toHaveBeenCalledWith("take_tenant_rate_tokens", {
      p_bucket: "requests",
      p_cost: 1,
      p_capacity: 120,
      p_refill_per_second: 2,
      p_force: false,
    });
  });

  it("reports a denial with the wait", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, remaining: 0, retry_after_ms: 1500 }], error: null });
    await expect(inTenant(() => takeTenantTokens("requests", 1, 60))).resolves.toEqual({
      allowed: false,
      retryAfterMs: 1500,
    });
  });

  it("fails open when the bucket is unavailable", async () => {
    const before = tenantMetricCount("tenant.rate_limit_unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    await expect(inTenant(() => takeTenantTokens("requests", 1, 60))).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    rpc.mockRejectedValue(new Error("network"));
    await expect(inTenant(() => takeTenantTokens("requests", 1, 60))).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    expect(tenantMetricCount("tenant.rate_limit_unavailable")).toBe(before + 2);
    warn.mockRestore();
  });

  it("admits an LLM call only with a request token and no token debt", async () => {
    const limits = { requestsPerMinute: 0, llmRequestsPerMinute: 30, llmTokensPerMinute: 10_000 };
    await inTenant(() => admitTenantLlmCall(limits));
    expect(rpc.mock.calls.map(([, args]) => [args.p_bucket, args.p_cost])).toEqual([
      ["llm-requests", 1],
      ["llm-tokens", 0],
    ]);

    rpc.mockResolvedValueOnce({ data: [{ allowed: false, retry_after_ms: 2000 }], error: null });
    const refused = await inTenant(() => admitTenantLlmCall(limits)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TenantRateLimitError);
    expect(refused).toBeInstanceOf(UserFacingError);
    expect(refused).toMatchObject({ bucket: "llm-requests", retryAfterMs: 2000 });
    expect((refused as Error).message).toMatch(/about 2 seconds/);

    rpc.mockResolvedValueOnce({ data: [{ allowed: true }], error: null });
    rpc.mockResolvedValueOnce({ data: [{ allowed: false, retry_after_ms: 40_000 }], error: null });
    await expect(inTenant(() => admitTenantLlmCall(limits))).rejects.toMatchObject({ bucket: "llm-tokens" });
  });

  it("charges a finished call's tokens as a forced debit", async () => {
    const limits = { requestsPerMinute: 0, llmRequestsPerMinute: 0, llmTokensPerMinute: 10_000 };
    await inTenant(() => chargeTenantLlmTokens(1234, limits));
    await inTenant(() => chargeTenantLlmTokens(0, limits));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_bucket: "llm-tokens", p_cost: 1234, p_force: true });
  });
});
