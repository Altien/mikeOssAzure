import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: undefined as unknown, rpc: vi.fn() }));
vi.mock("./supabase", () => ({ createServerSupabase: () => mocks.db }));
import { makeFakeDb } from "../test/helpers/fakeDb";
import { runWithTenant } from "./tenantContext";
import { flushTenantSettingsCache } from "./tenantSettings";
import { reserveTenantCredits, TenantBudgetError } from "./tenantCredits";
import { tenantMetricCount } from "./tenantMetrics";
import { completeWithProvider, streamWithProvider } from "./llm/providers";
import { flushLlmUsage, meterLlmCall, setLlmUsageSink, writeLlmUsageToLedger, type LlmCallDescriptor, type LlmUsageEvent } from "./llm/usage";

const CALL: LlmCallDescriptor = { model: "gpt-6-luna", provider: "openai", feature: "tabular", keyMode: "platform" };
const scoped = <T>(fn: () => T) => runWithTenant({ tenantId: "tenant-a", userId: "actor-a" }, fn);
let fake: ReturnType<typeof makeFakeDb>;
let events: LlmUsageEvent[];
function completion() { return Response.json({ id: "response-1", choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } }); }
function stream(tool: boolean) {
  const base = { id: tool ? "response-1" : "response-2", object: "chat.completion.chunk", created: 1, model: CALL.model };
  const chunks = tool ? [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ] : [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 2 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
beforeEach(() => {
  vi.stubEnv("TENANCY_MODE", "pooled"); vi.stubEnv("KEY_VAULT_NAME", "");
  vi.stubEnv("OPENAI_API_MODE", "chat");
  vi.stubEnv("TENANT_LLM_REQUESTS_PER_MINUTE", ""); vi.stubEnv("TENANT_LLM_TOKENS_PER_MINUTE", "");
  flushTenantSettingsCache();
  fake = makeFakeDb(() => ({ data: null, error: null }));
  mocks.db = { ...fake.db, rpc: mocks.rpc };
  mocks.rpc.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "reserve_tenant_credits") return { data: { allowed: true, id: args.p_id, price_version: "synthetic-v1", period_start: "2026-10-01", max_output_tokens: 64 }, error: null };
    if (name === "top_up_tenant_credits") return { data: { allowed: true }, error: null };
    if (name === "settle_tenant_credits") return { data: { credits: "0.0001", ledger_id: 1 }, error: null };
    return { data: [{ allowed: true }], error: null };
  });
  events = [];
  setLlmUsageSink(async (event) => { events.push(event); await writeLlmUsageToLedger(event); });
});
afterEach(async () => { vi.useRealTimers(); await flushLlmUsage(); setLlmUsageSink(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("tenant credit admission", () => {
  it("makes no credit database calls in single mode (with or without a tenant) or for BYO", async () => {
    expect(await scoped(() => reserveTenantCredits({ ...CALL, keyMode: "byo" }, "Hi"))).toBeUndefined();
    expect(await reserveTenantCredits({ ...CALL, keyMode: "byo" }, "Hi")).toBeUndefined();
    vi.stubEnv("TENANCY_MODE", "single");
    expect(await scoped(() => reserveTenantCredits(CALL, "Hi"))).toBeUndefined();
    expect(await reserveTenantCredits(CALL, "Hi")).toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  // Merge-review fix: a pooled platform-key call outside a tenant used to
  // skip admission and run unmetered; it now fails closed before any RPC.
  it("fails closed for a pooled platform-key call with no tenant", async () => {
    await expect(reserveTenantCredits(CALL, "Hi")).rejects.toMatchObject({ code: "tenant_budget_unavailable" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(tenantMetricCount("tenant.credit_budget.no_tenant")).toBeGreaterThan(0);
  });

  it.each(["unconfigured", "pricing_unavailable", "exhausted"])("fails closed for pooled %s policy before provider or ledger work", async (reason) => {
    mocks.rpc.mockResolvedValue({ data: { allowed: false, reason }, error: null });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const error = await scoped(() => completeWithProvider({ model: CALL.model, user: "Hi", apiKeys: { openai: "test-key" } })).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TenantBudgetError);
    expect(error).toMatchObject({ code: reason === "exhausted" ? "tenant_budget_exhausted" : "tenant_budget_unavailable", status: reason === "exhausted" ? 402 : 503 });
    expect(fetchMock).not.toHaveBeenCalled(); expect(events).toEqual([]);
  });

  it("fails closed on malformed or unavailable reservation responses", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(scoped(() => reserveTenantCredits(CALL, "Hi"))).rejects.toMatchObject({ code: "tenant_budget_unavailable" });
    mocks.rpc.mockResolvedValueOnce({ data: { allowed: true }, error: null });
    await expect(scoped(() => reserveTenantCredits(CALL, "Hi"))).rejects.toBeInstanceOf(TenantBudgetError);
  });

  it("uses the policy output ceiling and atomically settles the same cache-inclusive tokens as its ledger", async () => {
    const fetchMock = vi.fn(async () => completion()); vi.stubGlobal("fetch", fetchMock);
    await scoped(() => completeWithProvider({ model: CALL.model, user: "Hi", maxTokens: 512, apiKeys: { openai: "test-key" } }));
    await flushLlmUsage();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(64);
    expect(events[0]).toMatchObject({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, priceTableVersion: "synthetic-v1", creditPeriod: "2026-10-01", steps: 1, estimated: false });
    const settlement = mocks.rpc.mock.calls.find(([name]) => name === "settle_tenant_credits")?.[1];
    expect(settlement.p_event).toMatchObject({ input_tokens: 100, output_tokens: 7, cache_read_tokens: 40, price_table_version: "synthetic-v1", credit_period: "2026-10-01" });
    expect(fake.callsFor("llm_usage_events")).toHaveLength(0);
  });

  it("reserves again for growing tool-result prompts before the next provider request", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      const topups = mocks.rpc.mock.calls.filter(([name]) => name === "top_up_tenant_credits");
      expect(topups).toHaveLength(calls + 1);
      return stream(calls++ === 0);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await scoped(() => streamWithProvider({ model: CALL.model, systemPrompt: "", messages: [{ role: "user", content: "Read" }],
      apiKeys: { openai: "test-key" }, tools: [{ type: "function", function: { name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } } }],
      runTools: async () => [{ tool_use_id: "tool-1", content: "tool result ".repeat(500) }],
    }));
    await flushLlmUsage();
    expect(result.fullText).toBe("Done");
    const steps = mocks.rpc.mock.calls.filter(([name]) => name === "top_up_tenant_credits").map(([, args]) => args);
    expect(steps.map((args) => args.p_step)).toEqual([0, 1]);
    expect(steps[1].p_input_tokens).toBeGreaterThan(steps[0].p_input_tokens);
    expect(events[0]).toMatchObject({ inputTokens: 110, outputTokens: 7, steps: 2, estimated: false });
  });

  it("stops a tool loop with the intentional budget message before an unreserved second request", async () => {
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === "top_up_tenant_credits" && args.p_step === 1
      ? { data: { allowed: false, reason: "exhausted" }, error: null } : original(name, args));
    const fetchMock = vi.fn(async () => stream(true)); vi.stubGlobal("fetch", fetchMock);
    await expect(scoped(() => streamWithProvider({ model: CALL.model, systemPrompt: "", messages: [{ role: "user", content: "Read" }],
      apiKeys: { openai: "test-key" }, tools: [{ type: "function", function: { name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } } }],
      runTools: async () => [{ tool_use_id: "tool-1", content: "tool result" }],
    }))).rejects.toMatchObject({ code: "tenant_budget_exhausted" });
    await flushLlmUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, steps: 1, outcome: "failed" });
  });

  it("settles completed steps plus an in-flight prompt estimate on cancellation without double counting", async () => {
    const controller = new AbortController();
    await expect(scoped(() => meterLlmCall(CALL, async (meter) => {
      await meter.beforeStep({ prompt: "first" });
      meter.addStep({ inputTokens: 100, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 10 } });
      await meter.beforeStep({ prompt: "unreported second step" });
      meter.observeOutput("abcdefghi");
      controller.abort(); const error = new Error("cancelled"); error.name = "AbortError"; throw error;
    }, controller.signal, { prompt: "first", maxOutputTokens: 64 }))).rejects.toThrow("cancelled");
    await flushLlmUsage();
    const lastPrompt = mocks.rpc.mock.calls.filter(([name]) => name === "top_up_tenant_credits")[1][1].p_input_tokens;
    expect(events[0]).toMatchObject({ inputTokens: 100 + lastPrompt, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 10, outcome: "aborted", estimated: true, steps: 2 });
    const settlement = mocks.rpc.mock.calls.find(([name]) => name === "settle_tenant_credits")?.[1].p_event;
    expect(settlement.input_tokens).toBe(events[0].inputTokens);
    expect(settlement.output_tokens).toBe(events[0].outputTokens);
  });

  it("records a failed partial call, retains its original month/version, and releases no unmade next step", async () => {
    let steps = 0;
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === "top_up_tenant_credits" && steps++ > 0
      ? { data: { allowed: false, reason: "exhausted" }, error: null } : original(name, args));
    await expect(scoped(() => meterLlmCall(CALL, async (meter) => {
      await meter.beforeStep("first"); meter.addStep({ inputTokens: 20, outputTokens: 2 });
      vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:01Z"));
      await meter.beforeStep("too large next prompt");
    }, undefined, { prompt: "first" }))).rejects.toMatchObject({ code: "tenant_budget_exhausted" });
    vi.useRealTimers(); await flushLlmUsage();
    expect(events[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, steps: 1, outcome: "failed", priceTableVersion: "synthetic-v1", creditPeriod: "2026-10-01" });
  });

  it("retains unresolved holds when settlement fails and counts every failure", async () => {
    const before = tenantMetricCount("tenant.credit_budget.settlement_failed");
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === "settle_tenant_credits"
      ? { data: null, error: { code: "unavailable" } } : original(name, args));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await scoped(() => meterLlmCall(CALL, async (meter) => { await meter.beforeStep("Hi"); meter.addStep({ inputTokens: 10, outputTokens: 1 }); }, undefined, { prompt: "Hi" }));
    await flushLlmUsage();
    expect(tenantMetricCount("tenant.credit_budget.settlement_failed")).toBe(before + 1);
    expect(fake.callsFor("llm_usage_events")).toHaveLength(0);
  });

  it("keeps rate admission for BYO even though credit reservations are skipped", async () => {
    vi.stubEnv("TENANT_LLM_REQUESTS_PER_MINUTE", "1");
    fake = makeFakeDb(() => ({ data: { key_mode: "byo", model_allowlist: null, tier: null, config: {}, secret_refs: {} }, error: null }));
    mocks.db = { ...fake.db, rpc: mocks.rpc };
    mocks.rpc.mockResolvedValue({ data: [{ allowed: false, retry_after_ms: 1000 }], error: null });
    await expect(scoped(() => completeWithProvider({ model: CALL.model, user: "Hi" }))).rejects.toThrow("usage rate limit");
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["take_tenant_rate_tokens"]);
  });
});
