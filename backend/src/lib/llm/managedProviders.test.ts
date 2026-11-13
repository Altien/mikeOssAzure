import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isValidManagedModelList,
  MANAGED_BASE_URL_PATTERN,
  MANAGED_MODELS_PATTERN,
  managedProviderCatalog,
  parseManagedModels,
} from "./managedProviders";
import { providerForModel, resolveModel } from "./models";
import { completeWithProvider, streamWithProvider } from "./providers";
import { validBaseUrl } from "./registry";
import { hasApiKeyForModel, resolveEffectiveChatModel } from "../modelSelection";

const TOKENJUICE = {
  TOKENJUICE_API_KEY: "org-tokenjuice-key",
  TOKENJUICE_BASE_URL: "https://tj.example.test/api/v1/",
  TOKENJUICE_MODELS: "juice-large, vendor/juice-small",
};
const META = { META_API_KEY: "org-meta-key", META_MODELS: "muse-spark-1.1" };

function stubAll(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function completion() {
  return Response.json({
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "A title" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
}

function stubFetch() {
  const fetchMock = vi.fn(async () => completion());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentRequest(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(init.headers);
  return { url: String(url), authorization: headers.get("authorization"), body: JSON.parse(String(init.body)) };
}

describe("administrator-entered providers", () => {
  beforeEach(() => {
    stubAll({
      KEY_VAULT_NAME: "",
      TOKENJUICE_API_KEY: "",
      TOKENJUICE_BASE_URL: "",
      TOKENJUICE_MODELS: "",
      META_API_KEY: "",
      META_BASE_URL: "",
      META_MODELS: "",
      LLM_MAX_OUTPUT_TOKENS: "",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes both prefixes to their own provider", () => {
    expect(providerForModel("tokenjuice/juice-large")).toBe("tokenjuice");
    expect(providerForModel("meta/muse-spark-1.1")).toBe("meta");
    expect(resolveModel("tokenjuice/vendor/juice-small", "")).toBe("tokenjuice/vendor/juice-small");
    expect(resolveModel("tokenjuice/../secrets", "")).toBe("");
  });

  it("calls the configured URL and model with the organisation key, never a personal one", async () => {
    stubAll(TOKENJUICE);
    const fetchMock = stubFetch();
    await completeWithProvider({
      model: "tokenjuice/vendor/juice-small",
      user: "hello",
      apiKeys: { tokenjuice: "personal-key" },
    });
    const sent = sentRequest(fetchMock);
    expect(sent.url).toBe("https://tj.example.test/api/v1/chat/completions");
    expect(sent.authorization).toBe("Bearer org-tokenjuice-key");
    expect(sent.body.model).toBe("vendor/juice-small");
  });

  it("asks for the legacy output limit unless an operator overrides it", async () => {
    stubAll({ ...TOKENJUICE, ...META });
    async function streamedLimit(model: string) {
      const fetchMock = vi.fn(async () => new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
      vi.stubGlobal("fetch", fetchMock);
      await streamWithProvider({ model, systemPrompt: "", messages: [{ role: "user", content: "hello" }] });
      return sentRequest(fetchMock as never).body.max_tokens;
    }

    expect(await streamedLimit("tokenjuice/juice-large")).toBe(16_384);
    expect(await streamedLimit("meta/muse-spark-1.1")).toBe(16_384);

    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "2048");
    expect(await streamedLimit("meta/muse-spark-1.1")).toBe(2048);
  });

  it("uses Meta's default URL only while meta-base-url is unset", async () => {
    stubAll(META);
    const fetchMock = stubFetch();
    await completeWithProvider({ model: "meta/muse-spark-1.1", user: "hello" });
    expect(sentRequest(fetchMock).url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(sentRequest(fetchMock).authorization).toBe("Bearer org-meta-key");

    vi.stubEnv("META_BASE_URL", "https://meta-proxy.example.test/v2");
    const overridden = stubFetch();
    await completeWithProvider({ model: "meta/muse-spark-1.1", user: "hello" });
    expect(sentRequest(overridden).url).toBe("https://meta-proxy.example.test/v2/chat/completions");
  });

  it("asks for usage when streaming and sends no reasoning", async () => {
    stubAll(TOKENJUICE);
    const fetchMock = vi.fn(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await streamWithProvider({
      model: "tokenjuice/juice-large",
      systemPrompt: "",
      messages: [{ role: "user", content: "hello" }],
      reasoning: "high",
    });
    const { body } = sentRequest(fetchMock as never);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it.each([
    ["tokenjuice/juice-large", {}, "tokenjuice-api-key"],
    ["tokenjuice/juice-large", { TOKENJUICE_API_KEY: "k" }, "tokenjuice-base-url"],
    ["tokenjuice/juice-large", { TOKENJUICE_API_KEY: "k", TOKENJUICE_BASE_URL: "https://tj.example.test/v1" }, "tokenjuice-models"],
    ["meta/muse-spark-1.1", {}, "meta-api-key"],
    ["meta/muse-spark-1.1", { META_API_KEY: "k" }, "meta-models"],
  ])("sends an administrator to /install for an absent setting of %s (%#)", async (model, env, secret) => {
    stubAll(env);
    const fetchMock = stubFetch();
    const failure = completeWithProvider({ model, user: "hello" });
    await expect(failure).rejects.toThrow(secret);
    await expect(failure).rejects.toThrow("/install");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a model the administrator did not list, on the organisation's key", async () => {
    stubAll(TOKENJUICE);
    const fetchMock = stubFetch();
    await expect(completeWithProvider({ model: "tokenjuice/expensive", user: "hello" }))
      .rejects.toThrow("tokenjuice-models");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await hasApiKeyForModel("tokenjuice/expensive", { tokenjuice: "org-tokenjuice-key" })).toBe(false);
    expect(await hasApiKeyForModel("tokenjuice/juice-large", { tokenjuice: "org-tokenjuice-key" })).toBe(true);
  });

  it("tells chat which setting is missing rather than asking the user for a key", async () => {
    stubAll({ TOKENJUICE_API_KEY: "k", TOKENJUICE_MODELS: "juice-large" });
    const result = await resolveEffectiveChatModel({
      requested: "tokenjuice/juice-large",
      apiKeys: {},
      userId: "user-1",
      db: {} as never,
    });
    expect(result).toMatchObject({ ok: false, status: 422, code: "missing_api_key" });
    expect(result).toHaveProperty("detail", expect.stringContaining("tokenjuice-base-url"));
    expect(result).toHaveProperty("detail", expect.stringContaining("/install"));
  });

  it.each([
    "ftp://tj.example.test/v1",
    "https://user:pass@tj.example.test/v1",
    "https://tj.example.test/v1?key=1",
    "https://tj.example.test/v1#top",
    "not a url",
  ])("rejects the bad base URL %s without calling it", async (bad) => {
    stubAll({ ...TOKENJUICE, TOKENJUICE_BASE_URL: bad });
    const fetchMock = stubFetch();
    await expect(completeWithProvider({ model: "tokenjuice/juice-large", user: "hello" }))
      .rejects.toThrow(/invalid base URL.*tokenjuice-base-url/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await managedProviderCatalog()).toEqual([]);
    expect(validBaseUrl(bad)).toBe(false);
  });

  it("does not fall back to Meta's default when meta-base-url is bad", async () => {
    stubAll({ ...META, META_BASE_URL: "ftp://meta.example.test" });
    expect(await managedProviderCatalog()).toEqual([]);
  });

  it("offers models only once key, URL and model name are all set", async () => {
    expect(await managedProviderCatalog()).toEqual([]);

    vi.stubEnv("TOKENJUICE_API_KEY", TOKENJUICE.TOKENJUICE_API_KEY);
    expect(await managedProviderCatalog()).toEqual([]);
    vi.stubEnv("TOKENJUICE_BASE_URL", TOKENJUICE.TOKENJUICE_BASE_URL);
    expect(await managedProviderCatalog()).toEqual([]);
    vi.stubEnv("TOKENJUICE_MODELS", TOKENJUICE.TOKENJUICE_MODELS);
    expect(await managedProviderCatalog()).toEqual([
      { id: "tokenjuice/juice-large", label: "juice-large", group: "TokenJuice" },
      { id: "tokenjuice/vendor/juice-small", label: "vendor/juice-small", group: "TokenJuice" },
    ]);

    // Meta has a default address, so its key and model names are enough.
    vi.stubEnv("META_API_KEY", META.META_API_KEY);
    expect((await managedProviderCatalog()).map((model) => model.group)).not.toContain("Meta (Muse)");
    vi.stubEnv("META_MODELS", META.META_MODELS);
    expect(await managedProviderCatalog()).toContainEqual(
      { id: "meta/muse-spark-1.1", label: "muse-spark-1.1", group: "Meta (Muse)" },
    );
  });

  it("parses model lists and rejects names unsafe in a URL", () => {
    expect(parseManagedModels(" a-1,  b.2 ,a-1\nvendor/c ")).toEqual(["a-1", "b.2", "vendor/c"]);
    expect(parseManagedModels("good, ../bad, a?b")).toEqual(["good"]);
    expect(isValidManagedModelList("good, vendor/ok")).toBe(true);
    expect(isValidManagedModelList("good, a?b")).toBe(false);
    expect(isValidManagedModelList(" , ")).toBe(false);
  });

  it("keeps the browser patterns valid under the HTML pattern attribute's v flag", () => {
    const url = new RegExp(MANAGED_BASE_URL_PATTERN, "v");
    expect(url.test("https://api.meta.ai/v1")).toBe(true);
    expect(url.test("http://host.example.test:8080")).toBe(true);
    expect(url.test("https://user@host.example.test/v1")).toBe(false);
    expect(url.test("https://host.example.test/v1?x=1")).toBe(false);
    const models = new RegExp(MANAGED_MODELS_PATTERN, "v");
    expect(models.test("muse-spark-1.1, vendor/model:free")).toBe(true);
    expect(models.test("a?b")).toBe(false);
  });
});
