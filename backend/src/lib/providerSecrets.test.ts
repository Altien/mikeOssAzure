import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSecret } = vi.hoisted(() => ({ getSecret: vi.fn() }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/keyvault-secrets", () => ({
    SecretClient: class { getSecret = getSecret; },
}));

import { flushConfigCache, getConfig } from "./config";
import { resolveProviderSecret } from "./envSecrets";
import { getOrganisationApiKeys, resolveVercelApiKey } from "./userApiKeys";

beforeEach(() => {
    flushConfigCache();
    getSecret.mockReset().mockRejectedValue(new Error("SecretNotFound"));
    vi.stubEnv("KEY_VAULT_NAME", "test-vault");
    vi.stubEnv("OPENROUTER_API_KEY", "stale-env");
    vi.stubEnv("AI_GATEWAY_API_KEY", "stale-gateway-env");
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("organisation router credential precedence", () => {
    it("uses vault values for requests while preserving legacy config precedence", async () => {
        getSecret.mockImplementation(async (name: string) => ({
            value: name === "openrouter-api-key" ? "vault-router" : "__unset__",
        }));
        expect((await getOrganisationApiKeys()).openrouter).toBe("vault-router");
        expect(await getConfig("openrouter-api-key")).toBe("stale-env");
    });

    it("checks the Vercel vault alias before any environment fallback", async () => {
        getSecret.mockImplementation(async (name: string) => ({
            value: name === "vercel-ai-gateway-api-key" ? "vault-alias" : "__unset__",
        }));
        expect(await resolveVercelApiKey()).toBe("vault-alias");
    });

    it("falls back on absent/unavailable vault values and filters placeholders", async () => {
        expect(await resolveProviderSecret("openrouter-api-key")).toBe("stale-env");
        vi.stubEnv("AI_GATEWAY_API_KEY", " __unset__ ");
        vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", " local-alias ");
        expect(await resolveVercelApiKey()).toBe("local-alias");
    });

    it("does not contact Azure during environment-only local development", async () => {
        vi.stubEnv("KEY_VAULT_NAME", "");
        expect(await resolveProviderSecret("openrouter-api-key")).toBe("stale-env");
        expect(getSecret).not.toHaveBeenCalled();
    });
});
