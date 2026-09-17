import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("../../../lib/envSecrets", () => ({
  resolveSecret: vi.fn(async (name: string) => secrets.values.get(name) ?? ""),
  resolveProviderSecret: vi.fn(async (name: string) => secrets.values.get(name) ?? ""),
  resolveVercelApiKey: vi.fn(async () => secrets.values.get("ai-gateway-api-key") ?? ""),
}));

import { getUserApiKeyStatus, normalizeApiKeyProvider } from "../user.apiKeyStore";
import { saveApiKey } from "../user.apiKeys";

describe("organisation provider credentials", () => {
  beforeEach(() => secrets.values.clear());

  it("accepts supported providers without admitting arbitrary names", () => {
    for (const provider of ["claude", "gemini", "openai", "kimi", "openrouter", "opencode-go", "vercel", "courtlistener", "azure_openai"])
      expect(normalizeApiKeyProvider(provider)).toBe(provider);
    expect(normalizeApiKeyProvider("unknown")).toBeNull();
  });

  it("reports only organisation-backed sources and never reads a personal key row", async () => {
    secrets.values.set("openai-api-key", "organisation-openai");
    secrets.values.set("azure-openai-endpoint", "https://example.openai.azure.com/");
    secrets.values.set("azure-openai-api-key", "organisation-azure");
    const db = { from: vi.fn(() => { throw new Error("personal key lookup forbidden"); }) };
    const status = await getUserApiKeyStatus("entra|tenant|user", db as never);
    expect(status.openai).toBe(true);
    expect(status.azure_openai).toBe(true);
    expect(status.sources).toMatchObject({ openai: "env", azure_openai: "env", claude: null });
    expect(db.from).not.toHaveBeenCalled();
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