import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  guardedFetch: vi.fn(),
  vault: new Map<string, string>(),
}));

vi.mock("../supabase", () => ({ createServerSupabase: () => mocks.db }));
vi.mock("../mcp/client", () => ({ guardedFetch: mocks.guardedFetch }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    getSecret = async (name: string) => {
      const value = mocks.vault.get(name);
      if (value === undefined) throw Object.assign(new Error("Secret not found"), { statusCode: 404 });
      return { value };
    };
  },
}));

import { makeFakeDb } from "../../test/helpers/fakeDb";
import { flushConfigCache } from "../config";
import { UserFacingError } from "../safeError";
import { runWithTenant } from "../tenantContext";
import { flushTenantSettingsCache } from "../tenantSettings";
import { completeWithProvider } from "./providers";

function completion() {
  return Response.json({
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "A title" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
}

function tenantRow(row: Record<string, unknown>) {
  mocks.db = makeFakeDb(() => ({
    data: {
      key_mode: "byo", tier: null, model_allowlist: null, enabled_connectors: null,
      feature_flags: {}, config: {}, secret_refs: {}, ...row,
    },
  })).db;
}

const BYO_REFS = {
  "tokenjuice-api-key": "tenant-t1-tj-key",
  "tokenjuice-base-url": "tenant-t1-tj-url",
  "tokenjuice-models": "tenant-t1-tj-models",
};

function send() {
  return completeWithProvider({ model: "tokenjuice/juice-large", user: "hello" });
}

describe("egress for administrator-entered providers", () => {
  let plainFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.vault.clear();
    flushConfigCache();
    flushTenantSettingsCache();
    vi.stubEnv("KEY_VAULT_NAME", "test-vault");
    vi.stubEnv("TENANCY_MODE", "single");
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "");
    mocks.guardedFetch.mockReset().mockImplementation(async () => completion());
    plainFetch = vi.fn(async () => completion());
    vi.stubGlobal("fetch", plainFetch);
    mocks.vault.set("tenant-t1-tj-key", "tenant-key");
    mocks.vault.set("tenant-t1-tj-url", "https://byo.example.test/v1");
    mocks.vault.set("tenant-t1-tj-models", "juice-large");
    mocks.vault.set("tokenjuice-api-key", "org-key");
    mocks.vault.set("tokenjuice-base-url", "https://10.0.0.5/v1");
    mocks.vault.set("tokenjuice-models", "juice-large");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("guards a BYO tenant's address and sends it that tenant's key", async () => {
    tenantRow({ secret_refs: BYO_REFS });

    await runWithTenant({ tenantId: "t1" }, send);

    expect(plainFetch).not.toHaveBeenCalled();
    expect(mocks.guardedFetch).toHaveBeenCalledTimes(1);
    const [url, init, options] = mocks.guardedFetch.mock.calls[0] as [string, RequestInit, { label: string }];
    expect(String(url)).toBe("https://byo.example.test/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tenant-key");
    expect(options.label).toBe("Model endpoint URL");
  });

  it("tells a BYO user to ask an administrator when the address is blocked", async () => {
    tenantRow({ secret_refs: BYO_REFS });
    const blocked = Object.assign(new Error("Model endpoint URL resolves to a blocked network address."), { code: "ERR_BLOCKED_DESTINATION" });
    mocks.guardedFetch.mockRejectedValue(new TypeError("fetch failed", { cause: blocked }));

    const error = await runWithTenant({ tenantId: "t1" }, send).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toMatch(/administrator/);
    expect((error as Error).message).not.toMatch(/OpenAI-compatible|Model Providers/);
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("keeps plain fetch on a single install, so a private gateway still works", async () => {
    await send();

    expect(mocks.guardedFetch).not.toHaveBeenCalled();
    expect(String(plainFetch.mock.calls[0]?.[0])).toBe("https://10.0.0.5/v1/chat/completions");
  });

  it("keeps plain fetch for a tenant on the platform's own keys", async () => {
    tenantRow({ key_mode: "platform" });

    await runWithTenant({ tenantId: "t1" }, send);

    expect(mocks.guardedFetch).not.toHaveBeenCalled();
    expect(String(plainFetch.mock.calls[0]?.[0])).toBe("https://10.0.0.5/v1/chat/completions");
  });
});
