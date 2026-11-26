import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dev: upstream's first-run setup (createFirstAccount, MIKE_FIRST_RUN_SETUP)
// is not adopted; only the configured-only sign-in options are. The auth
// provider comes from Key Vault/config, falling back to AUTH_PROVIDER.
vi.mock("../../../lib/config", () => ({
  getConfig: vi.fn(async () => {
    throw new Error("not in Key Vault");
  }),
}));

import { resetSignInOptionsCache, signInOptions } from "../auth.service";

const settingsFetch = (body: unknown, ok = true) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

beforeEach(() => {
  process.env.AUTH_PROVIDER = "supabase";
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable";
  delete process.env.SSO_ENABLED;
  resetSignInOptionsCache();
});

afterEach(() => {
  delete process.env.AUTH_PROVIDER;
});

describe("signInOptions", () => {
  it("offers Google only when Supabase Auth has it switched on", async () => {
    const fetchImpl = settingsFetch({ external: { google: false } });
    await expect(signInOptions(fetchImpl)).resolves.toEqual({
      google: false,
      sso: false,
      setupRequired: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://project.supabase.test/auth/v1/settings",
      expect.objectContaining({ headers: { apikey: "publishable" } }),
    );
  });

  it("keeps Google visible when the settings cannot be read", async () => {
    await expect(signInOptions(settingsFetch({}, false))).resolves.toMatchObject({ google: true });
  });

  it("caches the provider settings", async () => {
    const fetchImpl = settingsFetch({ external: { google: true } });
    await signInOptions(fetchImpl);
    await signInOptions(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["entra", "local"])("offers neither Google nor SSO under %s auth, without probing GoTrue", async (provider) => {
    process.env.AUTH_PROVIDER = provider;
    const fetchImpl = settingsFetch({ external: { google: true } });
    await expect(signInOptions(fetchImpl)).resolves.toEqual({
      google: false,
      sso: false,
      setupRequired: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
