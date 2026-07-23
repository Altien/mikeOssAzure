import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({ getConfigMock: vi.fn() }));

vi.mock("./config", () => ({ getConfig: getConfigMock }));

import { readSecretEnv, resolveSecret } from "./envSecrets";

// The '__unset__' sentinel is what Bicep seeds KV secrets with so that
// secretRef'd Container App revisions can boot before the operator has
// provided real values. Both helpers must treat it as "no value".

const ENV = "ENV_SECRETS_TEST_VALUE";

beforeEach(() => {
  getConfigMock.mockReset();
});

afterEach(() => {
  delete process.env[ENV];
});

describe("readSecretEnv", () => {
  it("returns the trimmed value when set", () => {
    process.env[ENV] = "  real-value  ";

    expect(readSecretEnv(ENV)).toBe("real-value");
  });

  it("returns '' when the env var is missing", () => {
    expect(readSecretEnv(ENV)).toBe("");
  });

  it("returns '' for the __unset__ sentinel (with or without whitespace)", () => {
    process.env[ENV] = "__unset__";
    expect(readSecretEnv(ENV)).toBe("");

    process.env[ENV] = "  __unset__  ";
    expect(readSecretEnv(ENV)).toBe("");
  });
});

describe("resolveSecret", () => {
  it("returns the trimmed getConfig value", async () => {
    getConfigMock.mockResolvedValueOnce("  kv-value  ");

    expect(await resolveSecret("some-secret")).toBe("kv-value");
    expect(getConfigMock).toHaveBeenCalledWith("some-secret");
  });

  it("maps the __unset__ sentinel to ''", async () => {
    getConfigMock.mockResolvedValueOnce("__unset__");

    expect(await resolveSecret("some-secret")).toBe("");
  });

  it("fails closed ('') when getConfig rejects (KV not found / no vault)", async () => {
    getConfigMock.mockRejectedValueOnce(new Error("SecretNotFound"));

    expect(await resolveSecret("missing-secret")).toBe("");
  });

  it("maps empty / whitespace-only values to ''", async () => {
    getConfigMock.mockResolvedValueOnce("   ");

    expect(await resolveSecret("blank-secret")).toBe("");
  });
});
