import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: undefined as unknown, getSecret: vi.fn() }));
vi.mock("./supabase", () => ({ createServerSupabase: () => mocks.db }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/keyvault-secrets", () => ({ SecretClient: class { getSecret = mocks.getSecret; } }));

import { makeFakeDb } from "../test/helpers/fakeDb";
import { flushConfigCache } from "./config";
import { runWithTenant } from "./tenantContext";
import {
  assertTenantModelAllowed, flushTenantSettingsCache, getTenantConfig,
  getTenantSettings, resolveTenantSecret, type TenantSettings,
} from "./tenantSettings";
import { resolveProviderSecret, resolveSecret } from "./envSecrets";
import { getOrganisationApiKeys, getUserApiKeyStatus } from "./providerCredentials/store";
import { apiKeyForConfiguredModel, configuredEndpointSummaries, resetModelRegistryCache } from "./llm/registry";
import { resolveManagedProvider } from "./llm/managedProviders";
import { completeWithProvider, streamWithProvider } from "./llm/providers";
import { flushLlmUsage, setLlmUsageSink, type LlmUsageEvent } from "./llm/usage";
import { googleDriveOAuthEnv } from "./integrations/googleDrive";import { loadDeploymentSearchApiKeys } from "./webSearch/credentials";

const rows = new Map<string, TenantSettings>();
const secrets = new Map<string, string>();
function settings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return { key_mode: "platform", tier: null, model_allowlist: null,
    enabled_connectors: null, feature_flags: {}, config: {}, secret_refs: {}, ...overrides };
}
function fakeDb(error = false) {
  const fake = makeFakeDb((call) => {
    // Main's provider on/off switches are read from the user's profile;
    // none are saved here, so every provider stays enabled.
    if (call.table === "user_profiles") return { data: null };
    expect(call.table).toBe("tenant_settings");
    const tenant = call.filters.find(([op, col]) => op === "eq" && col === "tenant_id")?.[2];
    return error ? { error: { message: "unavailable" } } : { data: rows.get(String(tenant)) ?? null };
  });
  mocks.db = fake.db;
  return fake;
}
const asTenant = <T>(tenantId: string, fn: () => T): T => runWithTenant({ tenantId }, fn);

beforeEach(() => {
  rows.clear(); secrets.clear(); flushConfigCache(); flushTenantSettingsCache(); resetModelRegistryCache();
  fakeDb();
  vi.stubEnv("KEY_VAULT_NAME", "test-vault");
  vi.stubEnv("OPENAI_API_KEY", "platform-openai");
  vi.stubEnv("OPENAI_API_MODE", "chat");
  vi.stubEnv("MIKE_MODEL_CONFIG_JSON", "");
  vi.stubEnv("TENANCY_MODE", "single"); // no credit RPC or member-key reads in these unit tests
  mocks.getSecret.mockReset().mockImplementation(async (name: string) => ({ value: secrets.get(name) ?? "__unset__" }));
});
afterEach(() => {
  setLlmUsageSink(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("tenant configuration", () => {
  it("isolates concurrent cached settings for five minutes and inherits install defaults", async () => {
    rows.set("a", settings({ config: { "azure-openai-deployment": "a-deployment" } }));
    rows.set("b", settings({ config: { "azure-openai-deployment": "b-deployment" } }));
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "install-deployment");
    const fake = fakeDb();
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await Promise.all(["a", "b", "missing"].map((id) => asTenant(id, () => getTenantConfig("azure-openai-deployment")))))
      .toEqual(["a-deployment", "b-deployment", "install-deployment"]);
    rows.set("a", settings({ config: { "azure-openai-deployment": "changed" } }));
    expect(await asTenant("a", () => getTenantConfig("azure-openai-deployment"))).toBe("a-deployment");
    expect(fake.calls).toHaveLength(3);
    clock.mockReturnValue(now + 5 * 60_000);
    expect(await asTenant("a", () => getTenantConfig("azure-openai-deployment"))).toBe("changed");
    expect(fake.calls).toHaveLength(4);
  });

  it("keeps platform work outside tenant lookup and fails closed on a tenant read error", async () => {
    const fake = fakeDb(true);
    expect(await getTenantSettings()).toBeNull();
    expect(fake.calls).toEqual([]);
    await expect(asTenant("a", () => resolveProviderSecret("openai-api-key"))).rejects.toThrow("Unable to read tenant configuration");
    expect(await resolveProviderSecret("openai-api-key")).toBe("platform-openai");
  });

  it.each([
    "tokenjuice-api-key", "tokenjuice-base-url", "tokenjuice-models",
    "meta-api-key", "meta-base-url", "meta-models",
  ])("keeps the platform's %s from a BYO tenant", async (name) => {
    secrets.set(name, "platform-value");
    rows.set("byo", settings({ key_mode: "byo" }));
    rows.set("platform", settings());

    expect(await asTenant("byo", () => resolveProviderSecret(name))).toBe("");
    expect(await asTenant("platform", () => resolveProviderSecret(name))).toBe("platform-value");
  });

  it("gives a BYO tenant none of the platform's administrator-entered providers", async () => {
    secrets.set("meta-api-key", "platform-key");
    secrets.set("meta-models", "muse-spark-1.1");
    rows.set("byo", settings({ key_mode: "byo" }));

    const resolved = await asTenant("byo", () => resolveManagedProvider("meta"));

    expect(resolved).toMatchObject({ ok: false });
    expect(JSON.stringify(resolved)).not.toContain("platform-key");
  });

  it("uses only each BYO tenant's references, including when a caller supplies another key", async () => {
    for (const id of ["a", "b"]) {
      rows.set(id, settings({ key_mode: "byo", secret_refs: { "openai-api-key": `tenant-${id}-openai-api-key` } }));
      secrets.set(`tenant-${id}-openai-api-key`, `${id}-secret`);
    }
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({
      id: "chatcmpl_test", object: "chat.completion", created: 1, model: "gpt-6-luna",
      choices: [{ index: 0, message: { role: "assistant", content: "Title" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const usage: LlmUsageEvent[] = [];
    setLlmUsageSink(async (event) => { usage.push(event); });
    await Promise.all(["a", "b"].map((id) => asTenant(id, async () => {
      expect((await getOrganisationApiKeys()).openai).toBe(`${id}-secret`);
      expect(await completeWithProvider({ model: "gpt-6-luna", user: "Hi", apiKeys: { openai: "caller-key" } })).toBe("Title");
    })));
    await flushLlmUsage();
    expect(fetchMock.mock.calls.map((call) => new Headers(call[1].headers).get("authorization")).sort())
      .toEqual(["Bearer a-secret", "Bearer b-secret"]);
    expect(usage.map((event) => [event.tenantId, event.keyMode]).sort()).toEqual([["a", "byo"], ["b", "byo"]]);
  });

  it("never substitutes platform keys for absent BYO refs or missing referenced secrets", async () => {
    rows.set("a", settings({ key_mode: "byo" }));
    rows.set("b", settings({ key_mode: "byo", secret_refs: { "openai-api-key": "tenant-b-missing" } }));
    expect(await asTenant("a", () => resolveSecret("openai-api-key"))).toBe("");
    expect(await asTenant("b", () => resolveProviderSecret("openai-api-key"))).toBe("");
    rows.set("bad", settings({ key_mode: "byo", secret_refs: { "openai-api-key": "tenant-b-openai-api-key" } }));
    await expect(asTenant("bad", () => resolveProviderSecret("openai-api-key"))).rejects.toThrow("Invalid tenant credential reference");
  });

  // Merge into main: main's web-search keys are provider secrets too.
  it("never gives a BYO tenant the platform's web-search keys, even under an override name", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "platform-brave");
    vi.stubEnv("TAVILY_API_KEY", "platform-tavily");
    vi.stubEnv("DEEPSEEK_SEARCH_API_KEY", "platform-deepseek");
    vi.stubEnv("BRAVE_SEARCH_API_KEY_SECRET_NAME", "ops-brave-key");
    rows.set("a", settings({ key_mode: "byo", secret_refs: { "tavily-api-key": "tenant-a-tavily" } }));
    secrets.set("tenant-a-tavily", "a-tavily");
    expect(await asTenant("a", () => loadDeploymentSearchApiKeys()))
      .toEqual({ brave: null, tavily: "a-tavily", deepseek: null });
    rows.set("p", settings());
    expect(await asTenant("p", () => loadDeploymentSearchApiKeys()))
      .toEqual({ brave: "platform-brave", tavily: "platform-tavily", deepseek: "platform-deepseek" });
  });

  it("selects platform tier credentials before canonical fallback and ignores BYO refs in platform mode", async () => {
    rows.set("a", settings({ tier: "pro", secret_refs: { "openai-api-key": "tenant-a-unused" } }));
    secrets.set("platform-pro-openai-api-key", "tier-key");
    secrets.set("tenant-a-unused", "unused");
    vi.stubEnv("PLATFORM_PRO_OPENAI_API_KEY", "stale-tier-env");
    expect(await asTenant("a", () => resolveProviderSecret("openai-api-key"))).toBe("tier-key");
    rows.set("b", settings({ tier: "other" }));
    expect(await asTenant("b", () => resolveProviderSecret("openai-api-key"))).toBe("platform-openai");
  });

  it("resolves OAuth client refs independently of LLM key mode without mixing partial clients", async () => {
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "platform-client");
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "platform-secret");
    rows.set("a", settings({ secret_refs: {
      "google-drive-oauth-client-id": "tenant-a-google-client-id",
      "google-drive-oauth-client-secret": "tenant-a-google-client-secret",
    } }));
    secrets.set("tenant-a-google-client-id", "client-a"); secrets.set("tenant-a-google-client-secret", "secret-a");
    expect(await asTenant("a", googleDriveOAuthEnv)).toEqual({ clientId: "client-a", clientSecret: "secret-a" });
    rows.set("b", settings({ secret_refs: { "google-drive-oauth-client-id": "tenant-b-google-client-id" } }));
    secrets.set("tenant-b-google-client-id", "client-b");
    expect(await asTenant("b", googleDriveOAuthEnv)).toEqual({ clientId: "client-b", clientSecret: "" });
    rows.set("missing", settings({ secret_refs: { "google-drive-oauth-client-id": "tenant-missing-google-client-id" } }));
    vi.stubEnv("GOOGLE_MCP_OAUTH_CLIENT_ID", "fallback-client");
    vi.stubEnv("GOOGLE_MCP_OAUTH_CLIENT_SECRET", "fallback-secret");
    expect(await asTenant("missing", googleDriveOAuthEnv)).toEqual({ clientId: "", clientSecret: "" });
  });

  it("filters status/catalogs, exposes no secret values, and refuses both provider entrypoints before network or metering", async () => {
    vi.stubEnv("MIKE_MODEL_CONFIG_JSON", JSON.stringify({ models: [
      { id: "allowed-local", provider: "openai-compatible", location: "local", baseUrl: "http://localhost:8080/v1" },
      { id: "denied-local", provider: "openai-compatible", location: "local", baseUrl: "http://localhost:8080/v1" },
    ] }));
    rows.set("a", settings({ model_allowlist: ["allowed-local", "gpt-6-luna"] }));
    rows.set("b", settings({ model_allowlist: [] }));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const usage = vi.fn(); setLlmUsageSink(usage);
    await asTenant("a", async () => {
      expect((await configuredEndpointSummaries()).map((model) => model.id)).toEqual(["allowed-local"]);
      const status = await getUserApiKeyStatus("user");
      expect(status.modelAllowlist).toEqual(["allowed-local", "gpt-6-luna"]);
      expect(JSON.stringify(status)).not.toContain("platform-openai");
      await expect(completeWithProvider({ model: "gpt-6-astra", user: "Hi" })).rejects.toThrow("not enabled");
      await expect(streamWithProvider({ model: "gpt-6-astra", systemPrompt: "", messages: [] })).rejects.toThrow("not enabled");
    });
    await expect(asTenant("b", () => assertTenantModelAllowed("gpt-6-luna"))).rejects.toThrow("not enabled");
    expect(fetchMock).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });

  it("hybrid: a referenced provider uses the tenant key, others the platform key, never a mix; byo still fails closed", async () => {
    rows.set("h", settings({ key_mode: "hybrid", secret_refs: {
      "openai-api-key": "tenant-h-openai-api-key", "custom-base-url": "tenant-h-custom-base-url",
    } }));
    secrets.set("tenant-h-openai-api-key", "tenant-openai");
    secrets.set("anthropic-api-key", "platform-claude");
    secrets.set("custom-api-key", "platform-custom");
    rows.set("b", settings({ key_mode: "byo" }));
    await asTenant("h", async () => {
      expect(await resolveProviderSecret("openai-api-key")).toBe("tenant-openai");
      expect(await resolveProviderSecret("anthropic-api-key", ["claude-api-key"])).toBe("platform-claude");
      // The tenant names its own endpoint, so the platform key is never sent there.
      expect(await resolveProviderSecret("custom-api-key")).toBe("");
    });
    expect(await asTenant("b", () => resolveProviderSecret("anthropic-api-key", ["claude-api-key"]))).toBe("");
    expect(await asTenant("b", () => resolveProviderSecret("openai-api-key"))).toBe("");
  });

  it("uses a member's key only for a listed model, and meters calls on a tenant or member key as BYO", async () => {
    rows.set("m", settings({ key_mode: "hybrid", member_key_models: ["gpt-6-luna"],
      secret_refs: { "openai-api-key": "tenant-m-openai-api-key" } }));
    secrets.set("tenant-m-openai-api-key", "tenant-openai");
    rows.set("p", settings({ member_key_models: ["gpt-6-luna"] }));
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({
      id: "chatcmpl_test", object: "chat.completion", created: 1, model: "gpt-6-luna",
      choices: [{ index: 0, message: { role: "assistant", content: "Title" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const usage: LlmUsageEvent[] = [];
    setLlmUsageSink(async (event) => { usage.push(event); });
    const apiKeys = { openai: "caller-key", memberKeys: { openai: "member-key" } };
    await asTenant("m", async () => {
      await completeWithProvider({ model: "gpt-6-luna", user: "Hi", apiKeys });
      await completeWithProvider({ model: "gpt-6-astra", user: "Hi", apiKeys });
    });
    await asTenant("p", () => completeWithProvider({ model: "gpt-6-astra", user: "Hi", apiKeys }));
    await flushLlmUsage();
    expect(fetchMock.mock.calls.map((call) => new Headers(call[1].headers).get("authorization")))
      .toEqual(["Bearer member-key", "Bearer tenant-openai", "Bearer platform-openai"]);
    expect(usage.map((event) => [event.tenantId, event.model, event.keyMode])).toEqual([
      ["m", "gpt-6-luna", "byo"], ["m", "gpt-6-astra", "byo"], ["p", "gpt-6-astra", "platform"],
    ]);
  });

  it("resolves configured endpoint BYO refs instead of inline deployment keys", async () => {
    rows.set("a", settings({ key_mode: "byo", secret_refs: { "openai-api-key": "tenant-a-openai-api-key" } }));
    secrets.set("tenant-a-openai-api-key", "tenant-key");
    expect(await asTenant("a", () => apiKeyForConfiguredModel({
      id: "configured", provider: "openai-compatible", location: "cloud", baseUrl: "https://example.com/v1",
      apiKeyProvider: "openai", apiKey: "inline-platform-key",
    }, { openai: "override" }))).toBe("tenant-key");
    expect(await asTenant("a", () => resolveTenantSecret("custom", async () => "fallback"))).toBe("fallback");
  });
});
