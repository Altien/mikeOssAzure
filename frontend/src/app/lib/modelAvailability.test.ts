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
    "opencode-go"?: boolean;
}): ApiKeyState =>
    ({
        claude: { configured: !!configured.claude, source: null },
        gemini: { configured: !!configured.gemini, source: null },
        openai: { configured: !!configured.openai, source: null },
        openrouter: { configured: !!configured.openrouter, source: null },
        vercel: { configured: !!configured.vercel, source: null },
        "opencode-go": {
            configured: !!configured["opencode-go"],
            source: null,
        },
        courtlistener: { configured: false, source: null },
    }) as ApiKeyState;

describe("getModelProvider", () => {
    it("maps each settings model to a provider via its group", () => {
        expect(getModelProvider("claude-opus-5")).toBe("claude");
        expect(getModelProvider("claude-haiku-4-5")).toBe("claude");
        expect(getModelProvider("gemini-3.7-flash")).toBe("gemini");
        expect(getModelProvider("gemini-3-flash-preview")).toBe("gemini");
        expect(getModelProvider("gpt-5.6-sol")).toBe("openai");
        expect(getModelProvider("ollama/qwen3.6")).toBe("ollama");
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
            isModelAvailable("opencode-go/glm-5", keys({ "opencode-go": true })),
        ).toBe(true);
        // Each router gates on its own key, never a sibling's.
        expect(
            isModelAvailable("opencode-go/glm-5", keys({ vercel: true })),
        ).toBe(false);
    });

    it("allows an unknown model so server-managed dynamic models can resolve", () => {
        expect(
            isModelAvailable(
                "not-a-model",
                keys({ claude: true, gemini: true, openai: true }),
            ),
        ).toBe(true);
    });

    it("allows dynamic Ollama models without an API key", () => {
        expect(isModelAvailable("ollama/qwen3.6", keys({}))).toBe(true);
    });

    it("requires the configured OpenRouter key for dynamic models", () => {
        const withoutKey = keys({});
        const withKey = keys({}) as ApiKeyState;
        withKey.openrouter = { configured: true, source: "user" };
        expect(
            isModelAvailable(
                "openrouter/anthropic/claude-sonnet-4",
                withoutKey,
            ),
        ).toBe(false);
        expect(
            isModelAvailable("openrouter/anthropic/claude-sonnet-4", withKey),
        ).toBe(true);
    });

    it("requires the configured OpenCode Go key for dynamic models", () => {
        const withoutKey = keys({});
        const withKey = keys({}) as ApiKeyState;
        withKey["opencode-go"] = { configured: true, source: "user" };
        expect(
            isModelAvailable("opencode-go/qwen3.8-max", withoutKey),
        ).toBe(false);
        expect(
            isModelAvailable("opencode-go/qwen3.8-max", withKey),
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
        expect(providerLabel("local")).toBe("Local");
        expect(providerLabel("committee")).toBe("Committee");
        expect(providerLabel("claude")).toBe("Anthropic (Claude)");
        expect(providerLabel("kimi")).toBe("Moonshot (Kimi)");
        expect(providerLabel("openai")).toBe("OpenAI");
        expect(providerLabel("openrouter")).toBe("OpenRouter");
        expect(providerLabel("vercel")).toBe("Vercel AI Gateway");
        expect(providerLabel("opencode-go")).toBe("OpenCode Go");
        expect(providerLabel("ollama")).toBe("Local (Ollama)");
        expect(providerLabel("gemini")).toBe("Google (Gemini)");
        expect(providerLabel("openrouter")).toBe("OpenRouter");
        expect(providerLabel("opencode-go")).toBe("OpenCode Go");
    });
});

describe("modelGroupToProvider", () => {
    it("maps every model group to its provider id", () => {
        expect(modelGroupToProvider("Anthropic")).toBe("claude");
        expect(modelGroupToProvider("Moonshot")).toBe("kimi");
        expect(modelGroupToProvider("OpenAI")).toBe("openai");
        expect(modelGroupToProvider("OpenRouter")).toBe("openrouter");
        expect(modelGroupToProvider("OpenCode Go")).toBe("opencode-go");
        expect(modelGroupToProvider("Vercel AI Gateway")).toBe("vercel");
        expect(modelGroupToProvider("OpenCode Go")).toBe("opencode-go");
        expect(modelGroupToProvider("Local")).toBe("local");
        expect(modelGroupToProvider("Committee")).toBe("committee");
        expect(modelGroupToProvider("Google")).toBe("gemini");
        expect(modelGroupToProvider("OpenRouter")).toBe("openrouter");
        expect(modelGroupToProvider("OpenCode Go")).toBe("opencode-go");
    });
});
