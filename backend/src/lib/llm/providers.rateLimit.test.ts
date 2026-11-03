// Multi-tenant 017: a model call refused by the tenant's shared LLM limit
// never reaches the provider and records no usage row (015).
import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
// 014 reads tenant policy before calling the limiter; this fixture inherits install defaults.
const tenantSettings = { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
vi.mock("../supabase", () => ({ createServerSupabase: () => ({ rpc, from: () => tenantSettings }) }));

import { runWithTenant } from "../tenantContext";
import { TenantRateLimitError } from "../tenantRateLimit";
import { completeWithProvider, streamWithProvider } from "./providers";
import { flushLlmUsage, setLlmUsageSink, type LlmUsageEvent } from "./usage";

afterEach(() => {
  setLlmUsageSink(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("tenant LLM rate limit", () => {
  it("refuses before the provider request and records nothing", async () => {
    vi.stubEnv("TENANT_LLM_REQUESTS_PER_MINUTE", "1");
    rpc.mockResolvedValue({ data: [{ allowed: false, retry_after_ms: 30_000 }], error: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rows: LlmUsageEvent[] = [];
    setLlmUsageSink(async (event) => {
      rows.push(event);
    });

    await runWithTenant({ tenantId: "tenant-a" }, async () => {
      await expect(
        completeWithProvider({ model: "gpt-5.4", user: "Hi", apiKeys: { openai: "org-key" } }),
      ).rejects.toBeInstanceOf(TenantRateLimitError);
      await expect(
        streamWithProvider({
          model: "gpt-5.4",
          systemPrompt: "",
          messages: [{ role: "user", content: "Hi" }],
          apiKeys: { openai: "org-key" },
        }),
      ).rejects.toThrow(/usage rate limit/);
    });
    await flushLlmUsage();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(rpc).toHaveBeenCalledWith(
      "take_tenant_rate_tokens",
      expect.objectContaining({ p_bucket: "llm-requests", p_cost: 1, p_capacity: 1 }),
    );
  });
});
