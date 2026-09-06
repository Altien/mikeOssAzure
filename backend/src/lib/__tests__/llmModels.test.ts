import { afterEach, describe, it, expect, vi } from "vitest";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    OPENAI_MAIN_MODELS,
    CLAUDE_MID_MODELS,
    GEMINI_MID_MODELS,
    OPENAI_MID_MODELS,
    CLAUDE_LOW_MODELS,
    GEMINI_LOW_MODELS,
    OPENAI_LOW_MODELS,
    providerForModel,
    resolveModel,
    resolveUsableModel,
    openRouterModelId,
    vercelModelId,
    openCodeGoModelId,
    syntheticModelId,
    isOpenCodeGoChatCompletionsModel,
    isOpenCodeGoMessagesModel,
    isSupportedOpenCodeGoModel,
    normalizeReasoningLevelForModel,
    reasoningLevelsForModel,
} from "../llm/models";

afterEach(() => {
    vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// providerForModel
// ---------------------------------------------------------------------------

describe("providerForModel", () => {
    it("maps claude-* ids to the claude provider", () => {
        for (const model of [
            ...CLAUDE_MAIN_MODELS,
            ...CLAUDE_MID_MODELS,
            ...CLAUDE_LOW_MODELS,
        ]) {
            expect(providerForModel(model)).toBe("claude");
        }
    });

    it("maps gemini-* ids to the gemini provider", () => {
        for (const model of [
            ...GEMINI_MAIN_MODELS,
            ...GEMINI_MID_MODELS,
            ...GEMINI_LOW_MODELS,
        ]) {
            expect(providerForModel(model)).toBe("gemini");
        }
    });

    it("maps gpt-* ids to the openai provider", () => {
        for (const model of [
            ...OPENAI_MAIN_MODELS,
            ...OPENAI_MID_MODELS,
            ...OPENAI_LOW_MODELS,
        ]) {
            expect(providerForModel(model)).toBe("openai");
        }
    });

    it("maps built-in Kimi ids to the openai-compatible provider", () => {
        expect(providerForModel("kimi-k3")).toBe("openai-compatible");
        expect(providerForModel("kimi-k3-256k")).toBe("openai-compatible");
    });

    it("maps dynamic Ollama ids to the keyless Ollama provider", () => {
        expect(providerForModel("ollama/qwen3.6")).toBe("ollama");
    });

    it("maps namespaced Vercel AI Gateway ids to the vercel provider", () => {
        expect(providerForModel("vercel/anthropic/claude-sonnet-4.5")).toBe(
            "vercel",
        );
    });

    it("maps namespaced OpenRouter ids to the openrouter provider", () => {
        expect(providerForModel("openrouter/anthropic/claude-sonnet-4.5")).toBe(
            "openrouter",
        );
    });

    it("maps namespaced OpenCode Go ids to the opencode-go provider", () => {
        expect(providerForModel("opencode-go/glm-5")).toBe("opencode-go");
    });

    it("maps namespaced Synthetic ids to the synthetic provider", () => {
        expect(providerForModel("synthetic/syn:large:text")).toBe("synthetic");
        expect(providerForModel("synthetic/hf:zai-org/GLM-5.2")).toBe(
            "synthetic",
        );
    });

    it("throws on an unknown model id", () => {
        expect(() => providerForModel("llama-3")).toThrow(/Unknown model id/);
        expect(() => providerForModel("")).toThrow(/Unknown model id/);
    });

    it("infers by prefix only, without validating against the catalog", () => {
        // Documents current behavior: any claude-/gemini-/gpt- prefix is
        // accepted even if the id is not a canonical model.
        expect(providerForModel("claude-nonexistent")).toBe("claude");
        expect(providerForModel("gpt-nonexistent")).toBe("openai");
    });
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
    it("returns a known model id unchanged", () => {
        expect(resolveModel("claude-opus-5", "gemini-3-flash-preview")).toBe(
            "claude-opus-5",
        );
        expect(resolveModel("gemini-3.7-flash", "gemini-3-flash-preview")).toBe(
            "gemini-3.7-flash",
        );
        expect(resolveModel("gpt-5.6-sol", "gemini-3-flash-preview")).toBe(
            "gpt-5.6-sol",
        );
        expect(resolveModel("kimi-k3", "gemini-3-flash-preview")).toBe("kimi-k3");
        expect(resolveModel("ollama/qwen3.6", "gemini-3-flash-preview")).toBe(
            "ollama/qwen3.6",
        );
        expect(
            resolveModel("openrouter/openai/gpt-5", "gemini-3-flash-preview"),
        ).toBe("openrouter/openai/gpt-5");
    });

    it("falls back for unknown model ids", () => {
        expect(resolveModel("gpt-3.5-turbo", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
    });

    it("falls back for null, undefined, and empty ids", () => {
        expect(resolveModel(null, "gemini-3-flash-preview")).toBe("gemini-3-flash-preview");
        expect(resolveModel(undefined, "gemini-3.7-flash")).toBe(
            "gemini-3.7-flash",
        );
        expect(resolveModel("", "gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    });

    it("accepts models from every tier of the catalog", () => {
        const catalog = [
            ...CLAUDE_MAIN_MODELS,
            ...GEMINI_MAIN_MODELS,
            ...OPENAI_MAIN_MODELS,
            ...CLAUDE_MID_MODELS,
            ...GEMINI_MID_MODELS,
            ...OPENAI_MID_MODELS,
            ...CLAUDE_LOW_MODELS,
            ...GEMINI_LOW_MODELS,
            ...OPENAI_LOW_MODELS,
        ];
        for (const model of catalog) {
            expect(resolveModel(model, "fallback-model")).toBe(model);
        }
    });

    it("maps renamed legacy ids to their current equivalents", () => {
        // Stored preferences outlive catalog renames; without the mapping the
        // saved value silently degrades to the fallback.
        expect(
            resolveModel("gemini-3.1-flash-lite-preview", "gemini-3-flash-preview"),
        ).toBe("gemini-3.5-flash-lite");
        expect(resolveModel("gpt-5.4-lite", "gemini-3-flash-preview")).toBe(
            "gpt-5.4-mini",
        );
    });

    it("accepts namespaced OpenRouter model ids", () => {
        expect(
            resolveModel(
                "openrouter/meta-llama/llama-4-maverick",
                "gemini-3-flash-preview",
            ),
        ).toBe("openrouter/meta-llama/llama-4-maverick");
        expect(resolveModel("openrouter/invalid", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
    });

    it("accepts namespaced Vercel AI Gateway model ids", () => {
        expect(resolveModel("vercel/openai/gpt-5.4", "gemini-3-flash-preview")).toBe(
            "vercel/openai/gpt-5.4",
        );
        expect(resolveModel("vercel/invalid", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
    });

    it("accepts OpenCode Go's single-segment model ids", () => {
        // Unlike the other two routers, OpenCode Go's catalog ids are bare
        // names — requiring a vendor/model pair would reject all of them.
        expect(resolveModel("opencode-go/glm-5", "gemini-3-flash-preview")).toBe(
            "opencode-go/glm-5",
        );
        expect(resolveModel("opencode-go/", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
        expect(resolveModel("opencode-go/a b", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
    });

    it("accepts both Synthetic catalog id families", () => {
        for (const id of [
            "synthetic/syn:large:text",
            "synthetic/hf:zai-org/GLM-5.2",
            "synthetic/hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
        ]) {
            expect(resolveModel(id, "gemini-3-flash-preview")).toBe(id);
        }
        expect(resolveModel("synthetic/", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
    });
});

describe("syntheticModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(syntheticModelId("synthetic/syn:large:text")).toBe(
            "syn:large:text",
        );
        expect(syntheticModelId("synthetic/hf:zai-org/GLM-5.2")).toBe(
            "hf:zai-org/GLM-5.2",
        );
        expect(syntheticModelId("syn:large:text")).toBe("syn:large:text");
    });
});

describe("openCodeGoModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(openCodeGoModelId("opencode-go/glm-5")).toBe("glm-5");
        expect(openCodeGoModelId("glm-5")).toBe("glm-5");
    });
});

describe("OpenCode Go protocol classification", () => {
    it("classifies supported models and rejects unknown protocols", () => {
        expect(isOpenCodeGoChatCompletionsModel("opencode-go/glm-5.3")).toBe(
            true,
        );
        expect(isOpenCodeGoChatCompletionsModel("kimi-k3")).toBe(true);
        expect(isOpenCodeGoChatCompletionsModel("qwen3.8-max")).toBe(false);
        expect(isOpenCodeGoMessagesModel("opencode-go/qwen3.8-max")).toBe(
            true,
        );
        expect(isOpenCodeGoMessagesModel("minimax-m3")).toBe(true);
        expect(isSupportedOpenCodeGoModel("glm-5.3")).toBe(true);
        expect(isSupportedOpenCodeGoModel("qwen3.8-max")).toBe(true);
        expect(isSupportedOpenCodeGoModel("gpt-5.6-luna")).toBe(false);
        expect(isSupportedOpenCodeGoModel("future-model")).toBe(false);
    });
});

describe("openRouterModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(openRouterModelId("openrouter/openai/gpt-5.4")).toBe(
            "openai/gpt-5.4",
        );
    });

    it("preserves catalog ids that begin with the router's own slug", () => {
        // "openrouter/auto" is a real OpenRouter catalog id, so the app-level
        // id is "openrouter/openrouter/auto": resolveModel must accept it and
        // the adapter must strip exactly one namespace segment.
        expect(
            resolveModel("openrouter/openrouter/auto", "gemini-3-flash-preview"),
        ).toBe("openrouter/openrouter/auto");
        expect(openRouterModelId("openrouter/openrouter/auto")).toBe(
            "openrouter/auto",
        );
    });
});

describe("vercelModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(vercelModelId("vercel/openai/gpt-5.4")).toBe("openai/gpt-5.4");
    });

    it("preserves catalog ids that begin with the router's own slug", () => {
        expect(resolveModel("vercel/vercel/v0-1.5-md", "gemini-3-flash-preview")).toBe(
            "vercel/vercel/v0-1.5-md",
        );
        expect(vercelModelId("vercel/vercel/v0-1.5-md")).toBe(
            "vercel/v0-1.5-md",
        );
    });
});

// ---------------------------------------------------------------------------
// resolveUsableModel
// ---------------------------------------------------------------------------

describe("resolveUsableModel", () => {
    it("keeps a dynamic Ollama model without an API key", () => {
        expect(
            resolveUsableModel(
                "ollama/qwen3.6",
                "gemini-3-flash-preview",
                {},
            ),
        ).toBe("ollama/qwen3.6");
    });

    it("keeps a dynamic OpenRouter model when its user key is available", () => {
        expect(
            resolveUsableModel(
                "openrouter/anthropic/claude-sonnet-4",
                "gemini-3-flash-preview",
                { openrouter: "user-openrouter-key" },
            ),
        ).toBe("openrouter/anthropic/claude-sonnet-4");
    });

    it("keeps a dynamic Synthetic model when its user key is available", () => {
        expect(
            resolveUsableModel(
                "synthetic/syn:large:text",
                "gemini-3-flash-preview",
                { synthetic: "user-synthetic-key" },
            ),
        ).toBe("synthetic/syn:large:text");
    });

    it("keeps the selected model when its user API key is available", () => {
        expect(
            resolveUsableModel(
                "gemini-3-flash-preview",
                "gemini-3-flash-preview",
                { gemini: "user-gemini-key" },
            ),
        ).toBe("gemini-3-flash-preview");
    });

    it("uses an available configured model when the default has no key", () => {
        vi.stubEnv("GEMINI_API_KEY", "");
        vi.stubEnv("ANTHROPIC_API_KEY", "");
        vi.stubEnv("CLAUDE_API_KEY", "");
        vi.stubEnv("OPENAI_API_KEY", "");
        vi.stubEnv("KIMI_API_KEY", "");

        expect(
            resolveUsableModel(undefined, "gemini-3-flash-preview", {
                kimi: "user-kimi-key",
            }),
        ).toBe("kimi-k3");
    });

    it("falls back to a configured model with an env key when no provider keys are set", () => {
        vi.stubEnv("GEMINI_API_KEY", "");
        vi.stubEnv("ANTHROPIC_API_KEY", "");
        vi.stubEnv("CLAUDE_API_KEY", "");
        vi.stubEnv("OPENAI_API_KEY", "");
        vi.stubEnv("KIMI_API_KEY", "");
        // The local Qwen 3.8 (Dirk) model has its own env key, so it remains
        // the only usable configured model once every provider key is absent.
        vi.stubEnv("GUILFOYLE_DIRK_API_KEY", "test-key");
        expect(resolveUsableModel(undefined, "gemini-3-flash-preview", {})).toBe(
            "qwen3.8-local",
        );
    });
});

// ---------------------------------------------------------------------------
// No-silent-default contract
// ---------------------------------------------------------------------------

describe("no silent default model", () => {
    it("resolves unresolvable ids to an empty fallback so callers fail loudly", () => {
        expect(resolveModel("gpt-3.5-turbo", "")).toBe("");
        expect(resolveModel(undefined, "")).toBe("");
        expect(resolveModel(null, "")).toBe("");
    });

    it("still resolves catalog ids when the fallback is empty", () => {
        expect(resolveModel("gemini-3-flash-preview", "")).toBe(
            "gemini-3-flash-preview",
        );
    });
});

describe("reasoningLevelsForModel", () => {
    it("uses the GPT-5.6 subset exposed by the provider", () => {
        expect(reasoningLevelsForModel("gpt-5.6-terra")).toEqual([
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ]);
        expect(
            reasoningLevelsForModel("openrouter/openai/gpt-5.6-sol"),
        ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    });

    it("excludes Max for GPT-5.4 and GPT-5.5", () => {
        const expected = ["none", "low", "medium", "high", "xhigh"];
        expect(reasoningLevelsForModel("gpt-5.5")).toEqual(expected);
        expect(reasoningLevelsForModel("gpt-5.4")).toEqual(expected);
        expect(
            reasoningLevelsForModel("vercel/openai/gpt-5.5"),
        ).toEqual(expected);
    });

    it("normalizes stale levels to the nearest supported value", () => {
        expect(normalizeReasoningLevelForModel("gemini-3.7-flash", "max")).toBe(
            "xhigh",
        );
    });
});
