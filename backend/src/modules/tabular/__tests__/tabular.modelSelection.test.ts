import { afterEach, describe, expect, it } from "vitest";

import { resetModelRegistryCache } from "../../../lib/llm/registry";
import { missingModelApiKey } from "../tabular.shared";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

function configure(model: Record<string, unknown>) {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({ models: [model] });
    resetModelRegistryCache();
}

afterEach(() => {
    if (originalConfig === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
    else process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
    resetModelRegistryCache();
});

describe("configured tabular model authentication", () => {
    // Dev drift: Dev's missingModelApiKey is async (Key Vault-first credential
    // resolution), so these assertions await it.
    it("allows a cloud endpoint that declares no authentication source", async () => {
        configure({
            id: "keyless-cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://models.example.test/v1",
        });

        expect(await missingModelApiKey("keyless-cloud", {})).toBeNull();
    });

    it("rejects a configured endpoint when its declared key is unavailable", async () => {
        configure({
            id: "user-key-cloud",
            label: "User Key Cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://models.example.test/v1",
            apiKeyProvider: "openai",
        });

        expect(await missingModelApiKey("user-key-cloud", {})).toMatchObject({
            provider: "openai-compatible",
            model: "user-key-cloud",
        });
        expect(
            await missingModelApiKey("user-key-cloud", { openai: "user-key" }),
        ).toBeNull();
    });
});

describe("missingModelApiKey for provider keys", () => {
    it("says a switched-off provider is off rather than missing a key", async () => {
        const missing = await missingModelApiKey("claude-sonnet-5-5", {
            claude: null,
            disabledProviders: ["claude"],
        });
        expect(missing?.detail).toMatch(/Anthropic is turned off/);
        expect(missing?.detail).not.toMatch(/API key is required/);
    });

    it("needs the setting saved with a cloud key, like chat does", async () => {
        expect(
            (await missingModelApiKey("bedrock/anthropic.claude-sonnet-5-5", {
                bedrock: "key-without-region",
            }))?.detail,
        ).toMatch(/Amazon Bedrock is not configured for this organisation/);
        expect(
            (await missingModelApiKey("bedrock/anthropic.claude-sonnet-5-5", {
                bedrock: "key",
                providerSettings: { bedrock: { region: "us-east-1" } },
            })),
        ).toBeNull();
        expect(await missingModelApiKey("xai/grok-4.3", { xai: "key" })).toBeNull();
    });
});
