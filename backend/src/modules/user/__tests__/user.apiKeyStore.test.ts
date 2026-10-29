import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("../../../lib/envSecrets", () => ({
  resolveSecret: vi.fn(async (name: string) => secrets.values.get(name) ?? ""),
  resolveProviderSecret: vi.fn(async (name: string) => secrets.values.get(name) ?? ""),
  resolveVercelApiKey: vi.fn(async () => secrets.values.get("ai-gateway-api-key") ?? ""),
}));

import { getUserApiKeyStatus, normalizeApiKeyProvider } from "../user.apiKeyStore";
import { saveApiKey } from "../user.apiKeys";

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
  beforeEach(() => secrets.values.clear());

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

  it("refuses a personal provider key without writing any database row", async () => {
    const db = { from: vi.fn(() => { throw new Error("personal key write forbidden"); }) };
    const result = await saveApiKey(db as never, {
      userId: "entra|tenant|user", provider: "openai", apiKey: "personal-secret",
    });
    expect(result).toEqual({ ok: false, kind: "env_configured" });
    expect(db.from).not.toHaveBeenCalled();
  });
});
