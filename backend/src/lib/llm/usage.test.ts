// LLM usage ledger (multi-tenant issue 015): every model call through
// streamWithProvider / completeWithProvider records exactly one ledger row,
// with the ambient tenant, user and request id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 014 adds a tenant policy lookup; this ledger fixture inherits install defaults.
vi.mock("../supabase", () => ({ createServerSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }));

import { runWithRequestId } from "../requestContext";
import { runWithTenant } from "../tenantContext";
import { completeWithProvider, streamWithProvider } from "./providers";
import {
  flushLlmUsage,
  ledgerRow,
  meterLlmCall,
  recordLlmUsage,
  setLlmUsageSink,
  type LlmCallDescriptor,
  type LlmUsageEvent,
} from "./usage";

const CALL: LlmCallDescriptor = {
  feature: "chat",
  provider: "openai",
  model: "gpt-5.4",
  keyMode: "platform",
};

let rows: LlmUsageEvent[];

beforeEach(() => {
  vi.stubEnv("TENANCY_MODE", "single");
  rows = [];
  setLlmUsageSink(async (event) => {
    rows.push(event);
  });
});

afterEach(() => {
  setLlmUsageSink(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function openAiStream(text: string, usage = { prompt_tokens: 12, completion_tokens: 5 }): Response {
  const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-5.4" };
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: { ...usage, prompt_tokens_details: { cached_tokens: 4 } } },
  ]);
}

function openAiCompletion(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-2",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const streamParams = {
  model: "gpt-5.4",
  systemPrompt: "",
  messages: [{ role: "user" as const, content: "Hello" }],
  apiKeys: { openai: "org-key" },
};

describe("meterLlmCall", () => {
  it("records one completed row with summed steps, tenant, user and request id", async () => {
    const result = await runWithRequestId("req-1", () =>
      runWithTenant({ tenantId: "tenant-a", userId: "user-1" }, () =>
        meterLlmCall(CALL, async (meter) => {
          meter.addStep({ inputTokens: 10, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 3 } }, "r1");
          meter.addStep({ inputTokens: 20, outputTokens: 4, inputTokenDetails: { cacheWriteTokens: 5 } }, "r2");
          return "ok";
        }),
      ),
    );
    await flushLlmUsage();
    expect(result).toBe("ok");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "tenant-a",
      userId: "user-1",
      requestId: "req-1",
      feature: "chat",
      keyMode: "platform",
      inputTokens: 30,
      outputTokens: 6,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
      steps: 2,
      estimated: false,
      outcome: "completed",
      providerResponseId: "r2",
      priceTableVersion: null,
    });
  });

  it("records an aborted call with an estimate of the output produced", async () => {
    const controller = new AbortController();
    await expect(
      meterLlmCall(
        CALL,
        async (meter) => {
          meter.observeOutput("abcdefghi");
          controller.abort();
          const error = new Error("Stream aborted.");
          error.name = "AbortError";
          throw error;
        },
        controller.signal,
      ),
    ).rejects.toThrow("Stream aborted.");
    await flushLlmUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "aborted", outputTokens: 3, estimated: true, tenantId: null });
  });

  it("records a failed call and rethrows", async () => {
    await expect(
      meterLlmCall(CALL, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    await flushLlmUsage();
    expect(rows.map((r) => r.outcome)).toEqual(["failed"]);
  });

  it("never fails the call when the ledger write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLlmUsageSink(() => {
      throw new Error("db down");
    });
    await expect(meterLlmCall(CALL, async () => "ok")).resolves.toBe("ok");
    setLlmUsageSink(async () => Promise.reject(new Error("db down")));
    expect(() => recordLlmUsage({} as LlmUsageEvent)).not.toThrow();
    await flushLlmUsage();
    warn.mockRestore();
  });

  it("inserts no tenant_id: the column default takes it from the JWT claim", () => {
    const row = ledgerRow({
      tenantId: "tenant-a", userId: "u", requestId: null, feature: "memory", provider: "openai",
      model: "m", keyMode: "platform", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0,
      cacheWriteTokens: 0, steps: 1, estimated: false, outcome: "completed", latencyMs: 5,
      providerResponseId: null, priceTableVersion: null,
    });
    expect(row).not.toHaveProperty("tenant_id");
    expect(row).toMatchObject({ user_id: "u", feature: "memory", input_tokens: 1, output_tokens: 2 });
  });
});

describe("provider choke points", () => {
  // First use loads the AI SDK provider packages; slow under a parallel run.
  it("one row per call: streams, completions, retries and failures", { timeout: 30_000 }, async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean; reasoning_effort?: string };
      if (body.stream && body.reasoning_effort === "high") {
        // First attempt of the retry case: the provider names its levels.
        return new Response(
          JSON.stringify({
            error: {
              message: "Unsupported value: 'high' is not supported with this model. Supported values are: 'none', 'medium'.",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return body.stream ? openAiStream("Hi there") : openAiCompletion("A title");
    });
    vi.stubGlobal("fetch", fetchMock);

    await runWithTenant({ tenantId: "tenant-a", userId: "user-1" }, async () => {
      calls++;
      await streamWithProvider({ ...streamParams, feature: "chat" });
      calls++;
      await completeWithProvider({ model: "gpt-5.4", user: "Title", apiKeys: { openai: "org-key" }, feature: "chat-title" });
      calls++;
      await streamWithProvider({ ...streamParams, reasoning: "high", feature: "tabular" });
      calls++;
      await expect(
        completeWithProvider({ model: "claude-sonnet-4-6", user: "x", apiKeys: {}, feature: "memory" }),
      ).rejects.toThrow();
    });
    await flushLlmUsage();

    expect(rows).toHaveLength(calls);
    expect(rows.map((r) => [r.feature, r.outcome])).toEqual([
      ["chat", "completed"],
      ["chat-title", "completed"],
      ["tabular", "completed"],
      ["memory", "failed"],
    ]);
    expect(rows[0]).toMatchObject({
      tenantId: "tenant-a",
      userId: "user-1",
      provider: "openai",
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 4,
      steps: 1,
      estimated: false,
    });
    expect(rows[1]).toMatchObject({ inputTokens: 30, outputTokens: 7, steps: 1 });
    // The reasoning retry is one logical call: one row, two provider requests.
    expect(rows[2]).toMatchObject({ steps: 1, inputTokens: 12 });
    const streamBodies = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init.body)) as { stream?: boolean; stream_options?: unknown })
      .filter((b) => b.stream);
    expect(streamBodies).toHaveLength(3);
    for (const b of streamBodies) expect(b.stream_options).toEqual({ include_usage: true });
  });

  it("records background calls with the job's tenant and no user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openAiCompletion("done")));
    await runWithTenant({ tenantId: "tenant-b" }, () =>
      completeWithProvider({ model: "gpt-5.4", user: "Consolidate", apiKeys: { openai: "org-key" }, feature: "memory" }),
    );
    await flushLlmUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: "tenant-b", userId: null, requestId: null, feature: "memory" });
  });

  it("requests streaming usage from OpenAI-compatible providers (Kimi)", async () => {
    const fetchMock = vi.fn(async () => openAiStream("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await streamWithProvider({ ...streamParams, model: "kimi-k3", apiKeys: { kimi: "org-kimi-key" } });
    await flushLlmUsage();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "kimi", inputTokens: 12, outputTokens: 5 });
  });
});
