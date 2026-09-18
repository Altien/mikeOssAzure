import { describe, expect, it } from "vitest";
import { SETTINGS_MODELS } from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "./mikeApi";
import {
    getModelProvider,
    isModelAvailable,
    isProviderAvailable,
    modelGroupToProvider,
    providerLabel,
} from "./modelAvailability";

const keys = (configured: {
    claude?: boolean;
    gemini?: boolean;
    openai?: boolean;
    openrouter?: boolean;
    vercel?: boolean;
    opencodego?: boolean;
}): ApiKeyState =>
    ({
        claude: { configured: !!configured.claude, source: null },
        gemini: { configured: !!configured.gemini, source: null },
        openai: { configured: !!configured.openai, source: null },
        openrouter: { configured: !!configured.openrouter, source: null },
        vercel: { configured: !!configured.vercel, source: null },
        "opencode-go": {
            configured: !!configured.opencodego,
            source: null,
        },
        courtlistener: { configured: false, source: null },
    }) as ApiKeyState;

describe("getModelProvider", () => {
    it("maps each settings model to a provider via its group", () => {
        expect(getModelProvider("claude-opus-5")).toBe("claude");
        expect(getModelProvider("gemini-3.7-flash")).toBe("gemini");
        expect(getModelProvider("gpt-5.6-sol")).toBe("openai");
        expect(getModelProvider("openrouter/openai/gpt-5.4")).toBe(
            "openrouter",
        );
        expect(getModelProvider("vercel/openai/gpt-5.4")).toBe("vercel");
        expect(getModelProvider("opencode-go/glm-5")).toBe("opencode-go");
    });

    it("resolves any ollama/-prefixed id without consulting SETTINGS_MODELS", () => {
        // Ollama models are discovered at runtime, so they can never appear
        // in the static list — the prefix alone must be enough.
        expect(getModelProvider("ollama/llama3.2")).toBe("ollama");
        expect(getModelProvider("ollama/some-brand-new-model")).toBe("ollama");
    });

    it("resolves a provider for every model in SETTINGS_MODELS", () => {
        for (const model of SETTINGS_MODELS) {
            expect(getModelProvider(model.id)).not.toBeNull();
        }
    });

    it("returns null for an unknown model id", () => {
        expect(getModelProvider("not-a-model")).toBeNull();
    });
});

describe("isModelAvailable", () => {
    it("is true only when the model's provider has a configured key", () => {
        expect(isModelAvailable("claude-fable-5", keys({ claude: true }))).toBe(
            true,
        );
        expect(isModelAvailable("claude-fable-5", keys({ gemini: true }))).toBe(
            false,
        );
        expect(
            isModelAvailable(
                "openrouter/anthropic/claude-sonnet-4.5",
                keys({ openrouter: true }),
            ),
        ).toBe(true);
        expect(
            isModelAvailable(
                "vercel/anthropic/claude-sonnet-4.5",
                keys({ vercel: true }),
            ),
        ).toBe(true);
        expect(
            isModelAvailable("opencode-go/glm-5", keys({ opencodego: true })),
        ).toBe(true);
        // Each router gates on its own key, never a sibling's.
        expect(
            isModelAvailable("opencode-go/glm-5", keys({ vercel: true })),
        ).toBe(false);
    });

    it("is false for an unknown model regardless of keys", () => {
        expect(
            isModelAvailable(
                "not-a-model",
                keys({ claude: true, gemini: true, openai: true }),
            ),
        ).toBe(false);
    });

    it("accepts an authenticated configured model catalog id", () => {
        expect(
            isModelAvailable("local-qwen", keys({}), ["local-qwen"]),
        ).toBe(true);
    });

    it("is true for ollama models even with no keys configured", () => {
        expect(isModelAvailable("ollama/llama3.2", keys({}))).toBe(true);
    });
});

describe("isProviderAvailable", () => {
    it("reflects the configured flag for the provider", () => {
        expect(isProviderAvailable("openai", keys({ openai: true }))).toBe(
            true,
        );
        expect(isProviderAvailable("openai", keys({}))).toBe(false);
    });

    it("is false when the provider key is missing entirely", () => {
        expect(
            isProviderAvailable("claude", {} as unknown as ApiKeyState),
        ).toBe(false);
    });

    it("treats ollama as always available — local models need no API key", () => {
        expect(isProviderAvailable("ollama", keys({}))).toBe(true);
        expect(
            isProviderAvailable("ollama", {} as unknown as ApiKeyState),
        ).toBe(true);
    });
});

describe("providerLabel", () => {
    it("returns the display label for each provider", () => {
        expect(providerLabel("claude")).toBe("Anthropic (Claude)");
        expect(providerLabel("openai")).toBe("OpenAI");
        expect(providerLabel("openrouter")).toBe("OpenRouter");
        expect(providerLabel("vercel")).toBe("Vercel AI Gateway");
        expect(providerLabel("opencode-go")).toBe("OpenCode Go");
        expect(providerLabel("ollama")).toBe("Local (Ollama)");
        expect(providerLabel("gemini")).toBe("Google (Gemini)");
    });
});

describe("modelGroupToProvider", () => {
    it("maps every model group to its provider id", () => {
        expect(modelGroupToProvider("Anthropic")).toBe("claude");
        expect(modelGroupToProvider("OpenAI")).toBe("openai");
        expect(modelGroupToProvider("OpenRouter")).toBe("openrouter");
        expect(modelGroupToProvider("OpenCode Go")).toBe("opencode-go");
        expect(modelGroupToProvider("Vercel AI Gateway")).toBe("vercel");
        expect(modelGroupToProvider("Local")).toBe("ollama");
        expect(modelGroupToProvider("Google")).toBe("gemini");
    });
});

// Dev (OSS-6 §2.3 item 3): organisation Kimi and per-deployment Azure OpenAI.
describe("dev providers: kimi and azureOpenai", () => {
    const orgKeys = (configured: { kimi?: boolean; azure_openai?: boolean }) =>
        ({
            ...keys({}),
            kimi: { configured: !!configured.kimi, source: configured.kimi ? "env" : null },
            azure_openai: {
                configured: !!configured.azure_openai,
                source: configured.azure_openai ? "env" : null,
            },
        }) as ApiKeyState;
    const deployments = [
        { id: "aoai:prod-east", label: "prod-east", group: "Azure OpenAI" as const },
    ];

    it("maps the Kimi and Azure OpenAI groups and aoai: ids", () => {
        expect(modelGroupToProvider("Kimi")).toBe("kimi");
        expect(modelGroupToProvider("Azure OpenAI")).toBe("azureOpenai");
        expect(getModelProvider("kimi-k3")).toBe("kimi");
        expect(getModelProvider("aoai:anything")).toBe("azureOpenai");
        expect(providerLabel("kimi")).toBe("Kimi K3");
        expect(providerLabel("azureOpenai")).toBe("Azure OpenAI");
    });

    it("kimi availability follows the organisation credential", () => {
        expect(isModelAvailable("kimi-k3", orgKeys({ kimi: true }))).toBe(true);
        expect(isModelAvailable("kimi-k3", orgKeys({}))).toBe(false);
    });

    it("an aoai: deployment is available iff discovery returned it", () => {
        const configured = orgKeys({ azure_openai: true });
        expect(isModelAvailable("aoai:prod-east", configured, deployments)).toBe(true);
        expect(isModelAvailable("aoai:gone", configured, deployments)).toBe(false);
    });

    it("without the discovered list, aoai: falls back to the provider credential", () => {
        expect(isModelAvailable("aoai:prod-east", orgKeys({ azure_openai: true }))).toBe(true);
        expect(isModelAvailable("aoai:prod-east", orgKeys({}))).toBe(false);
        expect(isProviderAvailable("azureOpenai", orgKeys({ azure_openai: true }))).toBe(true);
    });
});
