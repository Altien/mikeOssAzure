import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  vault: new Map<string, string | Error>(),
}));

vi.mock("../supabase", () => ({ createServerSupabase: () => mocks.db }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    getSecret = async (name: string) => {
      const entry = mocks.vault.get(name);
      if (entry instanceof Error) throw entry;
      if (entry === undefined) throw Object.assign(new Error("Secret not found"), { statusCode: 404 });
      return { value: entry };
    };
  },
}));

import { makeFakeDb } from "../../test/helpers/fakeDb";
import { flushConfigCache } from "../config";
import { resolveProviderSecret } from "../envSecrets";
import { runWithTenant } from "../tenantContext";
import { flushTenantSettingsCache } from "../tenantSettings";
import { managedProviderCatalog, resolveManagedModel, resolveManagedProvider } from "./managedProviders";
import { completeWithProvider } from "./providers";
import { UserFacingError } from "../safeError";

const throttled = () => Object.assign(new Error("throttled by vault.example.test"), { statusCode: 429 });
const unavailable = () => Object.assign(new Error("service unavailable"), { statusCode: 503 });
const networkFailure = () => Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });

function tenantRow(row: Record<string, unknown>) {
  mocks.db = makeFakeDb(() => ({
    data: {
      key_mode: "platform", tier: null, model_allowlist: null, enabled_connectors: null,
      feature_flags: {}, config: {}, secret_refs: {}, ...row,
    },
  })).db;
}

describe("a base URL that cannot be read from Key Vault", () => {
  beforeEach(() => {
    mocks.vault.clear();
    flushConfigCache();
    flushTenantSettingsCache();
    vi.stubEnv("TENANCY_MODE", "single");
    vi.stubEnv("KEY_VAULT_NAME", "test-vault");
    vi.stubEnv("META_BASE_URL", "");
    vi.stubEnv("TOKENJUICE_BASE_URL", "");
    mocks.vault.set("meta-api-key", "org-key");
    mocks.vault.set("meta-models", "muse-spark-1.1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["a throttled read", throttled],
    ["a vault server error", unavailable],
    ["a network failure", networkFailure],
  ])("does not fall back to the default address after %s", async (_name, failure) => {
    mocks.vault.set("meta-base-url", failure());

    const resolved = await resolveManagedProvider("meta");

    expect(resolved).toEqual({ ok: false, detail: expect.stringContaining("meta-base-url") });
    expect(JSON.stringify(resolved)).not.toContain("api.meta.ai");
    expect(JSON.stringify(resolved)).not.toContain("org-key");
    expect(JSON.stringify(resolved)).not.toMatch(/throttled|unavailable|ETIMEDOUT/);
  });

  it("sends nothing to any host and tells the user why", async () => {
    mocks.vault.set("meta-base-url", throttled());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await completeWithProvider({ model: "meta/muse-spark-1.1", user: "hello" }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toContain("could not be read");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await resolveManagedModel("meta/muse-spark-1.1")).toMatchObject({ ok: false });
    expect(await managedProviderCatalog()).toEqual([]);
  });

  it.each([
    ["a 404", Object.assign(new Error("gone"), { statusCode: 404 })],
    ["SecretNotFound", Object.assign(new Error("gone"), { code: "SecretNotFound" })],
  ])("uses the default address after %s", async (_name, absence) => {
    mocks.vault.set("meta-base-url", absence);

    expect(await resolveManagedProvider("meta")).toMatchObject({
      ok: true,
      apiKey: "org-key",
      baseUrl: "https://api.meta.ai/v1",
    });
  });

  it("uses the default address for the Bicep placeholder", async () => {
    mocks.vault.set("meta-base-url", "__unset__");

    expect(await resolveManagedProvider("meta")).toMatchObject({ ok: true, baseUrl: "https://api.meta.ai/v1" });
  });

  it("uses an address that was read", async () => {
    mocks.vault.set("meta-base-url", "https://gateway.example.test/v1/");

    expect(await resolveManagedProvider("meta")).toMatchObject({ ok: true, baseUrl: "https://gateway.example.test/v1" });
  });

  it("does not take an environment address when the vault could not answer", async () => {
    mocks.vault.set("meta-base-url", throttled());
    vi.stubEnv("META_BASE_URL", "https://stale.example.test/v1");

    expect(await resolveManagedProvider("meta")).toMatchObject({ ok: false });
  });

  it("refuses when a platform tier's address cannot be read, rather than the global one", async () => {
    tenantRow({ tier: "gold" });
    mocks.vault.set("platform-gold-meta-base-url", throttled());
    mocks.vault.set("meta-base-url", "https://global.example.test/v1");

    const resolved = await runWithTenant({ tenantId: "t1" }, () => resolveManagedProvider("meta"));

    expect(resolved).toMatchObject({ ok: false });
  });

  it("refuses when a BYO tenant's own address cannot be read, rather than the default", async () => {
    tenantRow({
      key_mode: "byo",
      secret_refs: {
        "meta-api-key": "tenant-t1-meta-key",
        "meta-base-url": "tenant-t1-meta-url",
        "meta-models": "tenant-t1-meta-models",
      },
    });
    mocks.vault.set("tenant-t1-meta-key", "tenant-key");
    mocks.vault.set("tenant-t1-meta-models", "muse-spark-1.1");
    mocks.vault.set("tenant-t1-meta-url", throttled());

    const resolved = await runWithTenant({ tenantId: "t1" }, () => resolveManagedProvider("meta"));

    expect(resolved).toMatchObject({ ok: false });
  });

  it("leaves other callers treating a failed read as absent", async () => {
    mocks.vault.set("openai-api-key", throttled());
    vi.stubEnv("OPENAI_API_KEY", "from-env");

    await expect(resolveProviderSecret("openai-api-key")).resolves.toBe("from-env");
  });
});
