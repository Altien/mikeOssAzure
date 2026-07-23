import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// initDownloadSigningSecret's KV self-seed path, isolated from the
// signing tests in downloadTokens.test.ts because it needs module mocks
// for the dynamically-imported Azure SDKs (vi.mock intercepts dynamic
// import() too).

const { resolveSecretMock, setSecretMock, getSecretMock, secretClientCtor } =
  vi.hoisted(() => ({
    resolveSecretMock: vi.fn(),
    setSecretMock: vi.fn(),
    getSecretMock: vi.fn(),
    secretClientCtor: vi.fn(),
  }));

vi.mock("./envSecrets.js", () => ({ resolveSecret: resolveSecretMock }));
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    constructor(url: string, cred: unknown) {
      secretClientCtor(url, cred);
    }
    setSecret = setSecretMock;
    getSecret = getSecretMock;
  },
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
}));

import { initDownloadSigningSecret } from "./downloadTokens";

const TOUCHED = ["DOWNLOAD_SIGNING_SECRET", "KEY_VAULT_NAME"] as const;
const snapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of TOUCHED) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  resolveSecretMock.mockReset();
  resolveSecretMock.mockResolvedValue("");
  setSecretMock.mockReset();
  setSecretMock.mockResolvedValue(undefined);
  getSecretMock.mockReset();
  secretClientCtor.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("initDownloadSigningSecret", () => {
  it("no-ops when the env var is already set", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "already-configured-secret";

    await initDownloadSigningSecret();

    expect(resolveSecretMock).not.toHaveBeenCalled();
    expect(process.env.DOWNLOAD_SIGNING_SECRET).toBe("already-configured-secret");
  });

  it("warms the env from Key Vault via resolveSecret when the secret exists", async () => {
    resolveSecretMock.mockResolvedValueOnce("kv-held-secret");

    await initDownloadSigningSecret();

    expect(process.env.DOWNLOAD_SIGNING_SECRET).toBe("kv-held-secret");
    expect(secretClientCtor).not.toHaveBeenCalled(); // no self-seed needed
  });

  it("does nothing on local dev (no KEY_VAULT_NAME) — .env is the only source", async () => {
    await initDownloadSigningSecret();

    expect(process.env.DOWNLOAD_SIGNING_SECRET).toBeUndefined();
    expect(secretClientCtor).not.toHaveBeenCalled();
  });

  it("self-seeds: writes a fresh secret to the vault, converges on the re-read value, and logs", async () => {
    process.env.KEY_VAULT_NAME = "kv-mike-test";
    getSecretMock.mockResolvedValueOnce({ value: "settled-by-other-replica" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await initDownloadSigningSecret();

    expect(secretClientCtor).toHaveBeenCalledWith(
      "https://kv-mike-test.vault.azure.net/",
      expect.anything(),
    );
    const [name, fresh] = setSecretMock.mock.calls[0];
    expect(name).toBe("download-signing-secret");
    expect(typeof fresh).toBe("string");
    expect((fresh as string).length).toBeGreaterThanOrEqual(32);
    // Two replicas can race the write — the re-read value wins for BOTH,
    // so tokens signed by either replica verify everywhere.
    expect(process.env.DOWNLOAD_SIGNING_SECRET).toBe("settled-by-other-replica");
    expect(logSpy).toHaveBeenCalledWith(
      "download-signing-secret: self-seeded in Key Vault",
    );
  });

  it("falls back to its own fresh value when the re-read comes back empty", async () => {
    process.env.KEY_VAULT_NAME = "kv-mike-test";
    getSecretMock.mockResolvedValueOnce({ value: "" });

    await initDownloadSigningSecret();

    const fresh = setSecretMock.mock.calls[0][1] as string;
    expect(process.env.DOWNLOAD_SIGNING_SECRET).toBe(fresh);
  });

  it("never throws when the vault write fails — logs and leaves the env unset", async () => {
    process.env.KEY_VAULT_NAME = "kv-mike-test";
    setSecretMock.mockRejectedValueOnce(new Error("Forbidden by RBAC"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(initDownloadSigningSecret()).resolves.toBeUndefined();

    expect(process.env.DOWNLOAD_SIGNING_SECRET).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("self-seed failed"),
      expect.any(Error),
    );
  });
});
