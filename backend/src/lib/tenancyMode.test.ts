import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock("./config", () => ({ getConfig: mocks.getConfig }));

import { freezeTenancyMode, getTenancyMode, resetFrozenTenancyModeForTests } from "./tenancyMode";

// A normal install is one single system: no configuration means single.
// Pooled is opt-in, and a configuration source that cannot answer must never
// be read as "single".
const TOUCHED_ENV = ["TENANCY_MODE", "KEY_VAULT_NAME"] as const;
let saved: Record<string, string | undefined>;
const httpError = (statusCode: number) => Object.assign(new Error("Key Vault error"), { statusCode });

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED_ENV) delete process.env[key];
  resetFrozenTenancyModeForTests();
  mocks.getConfig.mockReset();
});
afterEach(() => {
  resetFrozenTenancyModeForTests();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("tenancy mode default", () => {
  it("is single with no TENANCY_MODE and no Key Vault, without reading any config", async () => {
    expect(await getTenancyMode()).toBe("single");
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it("treats an empty TENANCY_MODE without a Key Vault as absent", async () => {
    process.env.TENANCY_MODE = "";
    process.env.KEY_VAULT_NAME = "";
    expect(await getTenancyMode()).toBe("single");
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it("is single when the Key Vault has no tenancy-mode secret (404)", async () => {
    process.env.KEY_VAULT_NAME = "install-vault";
    mocks.getConfig.mockRejectedValue(httpError(404));
    expect(await getTenancyMode()).toBe("single");
    expect(mocks.getConfig).toHaveBeenCalledWith("tenancy-mode");
  });

  it("is single when the configured value is blank", async () => {
    process.env.KEY_VAULT_NAME = "install-vault";
    mocks.getConfig.mockResolvedValue("   ");
    expect(await getTenancyMode()).toBe("single");
  });

  it.each([
    ["an unreachable vault", Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })],
    ["a denied read (403)", httpError(403)],
    ["a vault outage (503)", httpError(503)],
  ])("throws, never selecting single, for %s", async (_name, error) => {
    process.env.KEY_VAULT_NAME = "install-vault";
    mocks.getConfig.mockRejectedValue(error);
    await expect(getTenancyMode()).rejects.toBe(error);
  });

  it("selects pooled only when configured, case- and space-insensitively", async () => {
    process.env.TENANCY_MODE = "pooled";
    mocks.getConfig.mockResolvedValue(" Pooled ");
    expect(await getTenancyMode()).toBe("pooled");
  });

  it("rejects an unknown mode instead of guessing", async () => {
    process.env.KEY_VAULT_NAME = "install-vault";
    mocks.getConfig.mockResolvedValue("multi");
    await expect(getTenancyMode()).rejects.toThrow("Invalid tenancy mode");
  });

  it("keeps the startup-frozen mode when configuration later changes", async () => {
    freezeTenancyMode("single");
    process.env.KEY_VAULT_NAME = "install-vault";
    mocks.getConfig.mockResolvedValue("pooled");
    expect(await getTenancyMode()).toBe("single");
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(() => freezeTenancyMode("pooled")).toThrow("already frozen");
  });
});
