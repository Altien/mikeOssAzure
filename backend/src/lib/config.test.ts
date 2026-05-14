import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { getSecretMock, setSecretMock, SecretClientCalls } = vi.hoisted(() => ({
  getSecretMock: vi.fn(),
  setSecretMock: vi.fn(),
  SecretClientCalls: [] as Array<[string, unknown]>,
}));

vi.mock("@azure/identity", () => {
  return {
    DefaultAzureCredential: class FakeCredential {},
  };
});

vi.mock("@azure/keyvault-secrets", () => {
  return {
    SecretClient: class FakeSecretClient {
      getSecret = getSecretMock;
      setSecret = setSecretMock;
      constructor(url: string, cred: unknown) {
        SecretClientCalls.push([url, cred]);
      }
    },
  };
});

const envSnapshot = {} as Record<string, string | undefined>;
const ENV_KEYS = [
  "CONFIG_CACHE_TTL_SECONDS",
  "KEY_VAULT_NAME",
  "USER_API_KEYS_ENCRYPTION_KEY",
  "SOME_SECRET",
  "WITH_HYPHENS_AND_NUMBERS_2",
] as const;

let getConfig: typeof import("./config").getConfig;
let flushConfigCache: typeof import("./config").flushConfigCache;
let setConfig: typeof import("./config").setConfig;

beforeEach(async () => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  getSecretMock.mockReset();
  setSecretMock.mockReset();
  SecretClientCalls.length = 0;

  // Fresh module per test so the KV cache and `secretClient` singleton
  // are isolated.
  vi.resetModules();
  ({ getConfig, flushConfigCache, setConfig } = await import("./config"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("getConfig — env-var override", () => {
  it("returns the env value when SOME_SECRET is set, never touching Key Vault", async () => {
    process.env.SOME_SECRET = "from-env";

    const value = await getConfig("some-secret");

    expect(value).toBe("from-env");
    expect(SecretClientCalls).toHaveLength(0);
    expect(getSecretMock).not.toHaveBeenCalled();
  });

  it("uppercases the name and converts hyphens to underscores when looking up the env var", async () => {
    process.env.WITH_HYPHENS_AND_NUMBERS_2 = "v";

    const value = await getConfig("with-hyphens-and-numbers-2");

    expect(value).toBe("v");
  });

  it("falls through to KV when the env override is the empty string", async () => {
    process.env.SOME_SECRET = "";
    process.env.KEY_VAULT_NAME = "kv";
    getSecretMock.mockResolvedValueOnce({ value: "from-kv" });

    const value = await getConfig("some-secret");

    expect(value).toBe("from-kv");
    expect(getSecretMock).toHaveBeenCalledWith("some-secret");
  });
});

describe("getConfig — KV path", () => {
  beforeEach(() => {
    process.env.KEY_VAULT_NAME = "test-kv";
  });

  it("builds the SecretClient with the right vault URL on first use", async () => {
    getSecretMock.mockResolvedValueOnce({ value: "v" });

    await getConfig("some-secret");

    expect(SecretClientCalls).toEqual([
      ["https://test-kv.vault.azure.net/", expect.any(Object)],
    ]);
  });

  it("caches a fetched value so a second getConfig within TTL doesn't refetch", async () => {
    getSecretMock.mockResolvedValueOnce({ value: "v1" });

    expect(await getConfig("some-secret")).toBe("v1");
    expect(await getConfig("some-secret")).toBe("v1");
    expect(await getConfig("some-secret")).toBe("v1");

    expect(getSecretMock).toHaveBeenCalledTimes(1);
  });

  it("caches per-secret-name — different names trigger separate fetches", async () => {
    getSecretMock.mockResolvedValueOnce({ value: "a" });
    getSecretMock.mockResolvedValueOnce({ value: "b" });

    expect(await getConfig("alpha")).toBe("a");
    expect(await getConfig("beta")).toBe("b");

    expect(getSecretMock).toHaveBeenCalledTimes(2);
    expect(getSecretMock).toHaveBeenNthCalledWith(1, "alpha");
    expect(getSecretMock).toHaveBeenNthCalledWith(2, "beta");
  });

  it("reuses the SecretClient across multiple calls (singleton)", async () => {
    getSecretMock.mockResolvedValueOnce({ value: "a" });
    getSecretMock.mockResolvedValueOnce({ value: "b" });

    await getConfig("alpha");
    await getConfig("beta");

    expect(SecretClientCalls).toHaveLength(1);
  });

  it("returns an empty string when the KV secret has no value", async () => {
    getSecretMock.mockResolvedValueOnce({ value: undefined });

    const value = await getConfig("some-secret");

    expect(value).toBe("");
  });

  it("throws when KEY_VAULT_NAME is not configured and no env override is present", async () => {
    delete process.env.KEY_VAULT_NAME;

    await expect(getConfig("some-secret")).rejects.toThrow(
      /KEY_VAULT_NAME env var is required/,
    );
  });
});

describe("flushConfigCache", () => {
  it("forces the next getConfig to refetch from KV", async () => {
    process.env.KEY_VAULT_NAME = "test-kv";
    getSecretMock.mockResolvedValueOnce({ value: "v1" });
    getSecretMock.mockResolvedValueOnce({ value: "v2-after-rotation" });

    expect(await getConfig("some-secret")).toBe("v1");
    flushConfigCache();
    expect(await getConfig("some-secret")).toBe("v2-after-rotation");

    expect(getSecretMock).toHaveBeenCalledTimes(2);
  });
});

describe("setConfig", () => {
  beforeEach(() => {
    process.env.KEY_VAULT_NAME = "test-kv";
  });

  it("writes the value to KV and returns the secret id", async () => {
    setSecretMock.mockResolvedValueOnce({
      properties: { id: "https://test-kv.vault.azure.net/secrets/x/abc" },
    });

    const id = await setConfig("x", "new-value");

    expect(setSecretMock).toHaveBeenCalledWith("x", "new-value");
    expect(id).toBe("https://test-kv.vault.azure.net/secrets/x/abc");
  });

  it("returns an empty string when the response has no id", async () => {
    setSecretMock.mockResolvedValueOnce({ properties: {} });

    const id = await setConfig("x", "v");

    expect(id).toBe("");
  });

  it("invalidates the cache entry for the same name on success", async () => {
    getSecretMock.mockResolvedValueOnce({ value: "old" });
    setSecretMock.mockResolvedValueOnce({ properties: { id: "id" } });
    getSecretMock.mockResolvedValueOnce({ value: "new" });

    expect(await getConfig("x")).toBe("old");
    await setConfig("x", "new");
    expect(await getConfig("x")).toBe("new");

    expect(getSecretMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT invalidate the cache entry for an unrelated name", async () => {
    getSecretMock.mockResolvedValueOnce({ value: "alpha-cached" });
    getSecretMock.mockResolvedValueOnce({ value: "beta-cached" });
    setSecretMock.mockResolvedValueOnce({ properties: { id: "id" } });

    await getConfig("alpha");
    await getConfig("beta");
    await setConfig("beta", "beta-new");

    // alpha is still cached → no extra fetch
    expect(await getConfig("alpha")).toBe("alpha-cached");
    expect(getSecretMock).toHaveBeenCalledTimes(2);
  });
});

describe("CONFIG_CACHE_TTL_SECONDS", () => {
  it("respects a custom TTL configured via the env var", async () => {
    process.env.CONFIG_CACHE_TTL_SECONDS = "0"; // disable cache
    process.env.KEY_VAULT_NAME = "test-kv";
    vi.resetModules();
    const mod = await import("./config");

    getSecretMock.mockResolvedValueOnce({ value: "a" });
    getSecretMock.mockResolvedValueOnce({ value: "b" });

    expect(await mod.getConfig("x")).toBe("a");
    expect(await mod.getConfig("x")).toBe("b");

    expect(getSecretMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a non-numeric CONFIG_CACHE_TTL_SECONDS (falls back to default)", async () => {
    process.env.CONFIG_CACHE_TTL_SECONDS = "not-a-number";
    process.env.KEY_VAULT_NAME = "test-kv";
    vi.resetModules();
    const mod = await import("./config");

    getSecretMock.mockResolvedValueOnce({ value: "a" });

    await mod.getConfig("x");
    await mod.getConfig("x");

    expect(getSecretMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a negative CONFIG_CACHE_TTL_SECONDS (falls back to default)", async () => {
    process.env.CONFIG_CACHE_TTL_SECONDS = "-30";
    process.env.KEY_VAULT_NAME = "test-kv";
    vi.resetModules();
    const mod = await import("./config");

    getSecretMock.mockResolvedValueOnce({ value: "a" });

    await mod.getConfig("x");
    await mod.getConfig("x");

    expect(getSecretMock).toHaveBeenCalledTimes(1);
  });
});
