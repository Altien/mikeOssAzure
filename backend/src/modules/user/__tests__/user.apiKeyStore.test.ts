import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("../../../lib/envSecrets", () => ({
  resolveSecret: vi.fn(async (name: string) => secrets.values.get(name) ?? ""),
  resolveProviderSecret: vi.fn(async (name: string) => secrets.values.get(name) ?? ""),
  resolveVercelApiKey: vi.fn(async () => secrets.values.get("ai-gateway-api-key") ?? ""),
}));

const allowlist = vi.hoisted(() => ({ value: null as string[] | null, memberKeyModels: null as string[] | null }));
vi.mock("../../../lib/tenantSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tenantSettings")>()),
  tenantModelAllowlist: vi.fn(async () => allowlist.value),
  getTenantSettings: vi.fn(async () => allowlist.memberKeyModels && { member_key_models: allowlist.memberKeyModels }),
}));

import { getApiKeyStatusFor, getUserApiKeyStatus, normalizeApiKeyProvider, orgKeyOwner } from "../user.apiKeyStore";
import { saveApiKey } from "../user.apiKeys";
import { freezeTenancyMode, resetFrozenTenancyModeForTests } from "../../../lib/tenancyMode";

function profilePreferenceDb() {
  const from = vi.fn((table: string) => {
    if (table !== "user_profiles") throw new Error(`secret-row lookup forbidden: ${table}`);
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: { provider_enabled: {} }, error: null }));
    query.single = vi.fn(async () => ({ data: { provider_enabled: {} }, error: null }));
    return query;
  });
  return { from };
}

describe("organisation provider credentials", () => {
  beforeEach(() => {
    secrets.values.clear();
    allowlist.value = null;
  });

  describe("administrator-entered model names in organisation settings", () => {
    beforeEach(() => {
      secrets.values.set("tokenjuice-api-key", "org-key");
      secrets.values.set("tokenjuice-base-url", "https://tj.example.test/v1");
      secrets.values.set("tokenjuice-models", "juice-large, juice-small");
      secrets.values.set("meta-api-key", "org-key");
      secrets.values.set("meta-models", "muse-spark-1.1, muse-private");
    });

    it("shows every name when the tenant has no allowlist", async () => {
      const { settings } = await getApiKeyStatusFor(orgKeyOwner("org-1"), {} as never);
      expect(settings.tokenjuice?.models).toEqual(["juice-large", "juice-small"]);
      expect(settings.meta?.models).toEqual(["muse-spark-1.1", "muse-private"]);
    });

    it("hides names outside a restricted tenant's allowlist", async () => {
      allowlist.value = ["tokenjuice/juice-small", "meta/muse-spark-1.1", "juice-large", "gpt-6.1-sol"];

      const status = await getApiKeyStatusFor(orgKeyOwner("org-1"), {} as never);

      expect(status.settings.tokenjuice?.models).toEqual(["juice-small"]);
      expect(status.settings.meta?.models).toEqual(["muse-spark-1.1"]);
      expect(JSON.stringify(status)).not.toContain("muse-private");
      expect(JSON.stringify(status)).not.toContain("juice-large");
    });

    it("shows no names under an empty allowlist, and leaves an unconfigured provider empty", async () => {
      allowlist.value = [];
      secrets.values.delete("meta-api-key");

      const { settings } = await getApiKeyStatusFor(orgKeyOwner("org-1"), {} as never);

      expect(settings.tokenjuice?.models).toEqual([]);
      expect(settings.meta ?? null).toBeNull();
    });
  });

  it("accepts supported providers without admitting arbitrary names", () => {
    for (const provider of ["claude", "gemini", "openai", "kimi", "mistral", "openrouter", "opencode-go", "vercel", "courtlistener", "azure_openai"])
      expect(normalizeApiKeyProvider(provider)).toBe(provider);
    expect(normalizeApiKeyProvider("unknown")).toBeNull();
  });

  it("reports centrally sourced providers while permitting only profile preference reads", async () => {
    secrets.values.set("openai-api-key", "organisation-openai");
    secrets.values.set("azure-openai-endpoint", "https://example.openai.azure.com/");
    secrets.values.set("azure-openai-api-key", "organisation-azure");
    const db = profilePreferenceDb();
    const status = await getUserApiKeyStatus("entra|tenant|user", db as never);
    expect(status.openai).toBe(true);
    expect(status.azure_openai).toBe(true);
    expect(status.mistral).toBe(false);
    expect(status.sources).toMatchObject({ openai: "env", azure_openai: "env", claude: null, mistral: null });
    const tables = db.from.mock.calls.map(([table]) => table);
    expect(tables).not.toContain("user_api_keys");
    expect(tables).not.toContain("org_api_keys");
  });

  it("reads direct Mistral credentials centrally without accessing secret rows", async () => {
    secrets.values.set("mistral-api-key", "organisation-mistral");
    const db = profilePreferenceDb();
    const status = await getUserApiKeyStatus("entra|tenant|user", db as never);
    expect(status.mistral).toBe(true);
    expect(status.sources).toMatchObject({ mistral: "env" });
    const tables = db.from.mock.calls.map(([table]) => table);
    expect(tables).not.toContain("user_api_keys");
    expect(tables).not.toContain("org_api_keys");
  });

  it("reports an administrator-entered provider only when complete, and never its values", async () => {
    const db = profilePreferenceDb();
    secrets.values.set("tokenjuice-api-key", "secret-tokenjuice-value");
    secrets.values.set("tokenjuice-models", "juice-large");
    secrets.values.set("meta-api-key", "secret-meta-value");
    const partial = await getUserApiKeyStatus("entra|tenant|user", db as never);
    expect(partial).toMatchObject({ tokenjuice: false, meta: false });
    expect(partial.sources).toMatchObject({ tokenjuice: null, meta: null });

    secrets.values.set("tokenjuice-base-url", "https://tj.example.test/v1");
    secrets.values.set("meta-models", "muse-spark-1.1");
    const status = await getUserApiKeyStatus("entra|tenant|user", db as never);
    expect(status).toMatchObject({ tokenjuice: true, meta: true });
    expect(status.sources).toMatchObject({ tokenjuice: "env", meta: "env" });
    const wire = JSON.stringify(status);
    for (const value of ["secret-tokenjuice-value", "secret-meta-value", "tj.example.test", "juice-large", "muse-spark"])
      expect(wire).not.toContain(value);
  });

  it("refuses a personal provider key without writing any database row", async () => {
    const db = { from: vi.fn(() => { throw new Error("personal key write forbidden"); }) };
    const result = await saveApiKey(db as never, {
      userId: "entra|tenant|user", provider: "openai", apiKey: "personal-secret",
    });
    expect(result).toEqual({ ok: false, kind: "env_configured" });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("pooled: refuses a member key for a provider with no listed model, writing nothing", async () => {
    allowlist.memberKeyModels = ["claude-sonnet-4-5"];
    freezeTenancyMode("pooled");
    try {
      const db = { from: vi.fn(() => { throw new Error("personal key write forbidden"); }) };
      const result = await saveApiKey(db as never, {
        userId: "entra|tenant|user", provider: "openai", apiKey: "personal-secret",
      });
      expect(result).toEqual({ ok: false, kind: "member_key_not_enabled" });
      expect(db.from).not.toHaveBeenCalled();
    } finally {
      resetFrozenTenancyModeForTests();
      allowlist.memberKeyModels = null;
    }
  });
});
