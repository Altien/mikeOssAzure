/**
 * Word add-in composer availability semantics, exercised from the frontend
 * test runner (the add-in package has no unit-test runner of its own).
 */
import { describe, expect, it, vi } from "vitest";
import {
    isAllowedModelId, isModelAllowed, isModelAvailable,
    providerKeyStates,
    unavailableModelMessage,
} from "../../../word-addin/src/taskpane/lib/modelCatalog";
import { isModelAvailable as isWebModelAvailable } from "../app/lib/modelAvailability";
import { loadWithRetry } from "../../../word-addin/src/taskpane/lib/composerPreflight";
import type { ApiKeyStatus } from "../../../word-addin/src/taskpane/types";

const NO_KEYS: ApiKeyStatus = {
    claude: false,
    gemini: false,
    openai: false,
    openrouter: false,
    vercel: false,
    "opencode-go": false,
    courtlistener: false,
} as ApiKeyStatus;

describe("isModelAvailable fail-open", () => {
    it("accepts only authenticated configured catalog IDs beyond static models", () => {
        expect(isAllowedModelId("custom-cloud")).toBe(false);
        expect(isAllowedModelId("custom-cloud", ["custom-cloud"])).toBe(true);
        expect(isModelAvailable("custom-cloud", NO_KEYS)).toBe(false);
        expect(isModelAvailable("custom-cloud", NO_KEYS, ["custom-cloud"])).toBe(true);
    });
    it("allows sends while key status is unknown (null)", () => {
        // A flaky WKWebView preflight must not brick the composer: the
        // backend still rejects models it cannot serve.
        expect(isModelAvailable("gemini-3.8-flash", null)).toBe(true);
        expect(isModelAvailable("claude-fable-5-1", null)).toBe(true);
        expect(isModelAvailable("openrouter/openai/gpt-5.4", null)).toBe(true);
        expect(isModelAvailable("vercel/openai/gpt-5.4", null)).toBe(true);
        expect(isModelAvailable("opencode-go/glm-5", null)).toBe(true);
    });

    it("still gates on a LOADED status", () => {
        expect(isModelAvailable("gemini-3.8-flash", NO_KEYS)).toBe(false);
        expect(isModelAvailable("openrouter/openai/gpt-5.4", NO_KEYS)).toBe(
            false,
        );
        expect(isModelAvailable("opencode-go/glm-5", NO_KEYS)).toBe(false);
        expect(
            isModelAvailable("gemini-3.8-flash", {
                ...NO_KEYS,
                gemini: true,
            }),
        ).toBe(true);
        expect(
            isModelAvailable("opencode-go/glm-5", {
                ...NO_KEYS,
                "opencode-go": true,
            }),
        ).toBe(true);
    });
});

describe("tenant model allowlist", () => {
    const OPENAI = { ...NO_KEYS, openai: true };

    it("hides a keyed model outside the tenant allowlist, as the web app does", () => {
        const status = { ...OPENAI, modelAllowlist: ["gpt-6-luna"] };
        expect(isModelAvailable("gpt-6-luna", status)).toBe(true);
        expect(isModelAvailable("gpt-6.1-sol", status)).toBe(false);
        expect(isModelAvailable("gpt-6.1-sol", status)).toBe(
            isWebModelAvailable("gpt-6.1-sol", {
                openai: { configured: true },
                modelAllowlist: ["gpt-6-luna"],
            }),
        );
    });

    it("matches legacy ids by their canonical id", () => {
        const status = { ...OPENAI, modelAllowlist: ["gpt-6-luna"] };
        expect(isModelAvailable("gpt-5.4-mini", status)).toBe(true);
    });

    it("applies to configured and local models too", () => {
        const status = { ...NO_KEYS, modelAllowlist: ["allowed-local"] };
        expect(isModelAvailable("custom-cloud", status, ["custom-cloud"])).toBe(false);
        expect(isModelAllowed("custom-cloud", status)).toBe(false);
        expect(isModelAllowed("allowed-local", status)).toBe(true);
    });

    it("permits nothing for an empty allowlist and everything when absent or null", () => {
        expect(isModelAvailable("gpt-6-luna", { ...OPENAI, modelAllowlist: [] })).toBe(false);
        expect(isModelAvailable("gpt-6-luna", { ...OPENAI, modelAllowlist: null })).toBe(true);
        expect(isModelAvailable("gpt-6-luna", OPENAI)).toBe(true);
    });

    it("fails open while the key status is unknown", () => {
        expect(isModelAllowed("gpt-6-luna", null)).toBe(true);
    });

    it("does not treat the allowlist as a provider key", () => {
        expect(
            Object.keys(providerKeyStates({ ...OPENAI, modelAllowlist: ["gpt-6-luna"] })),
        ).not.toContain("modelAllowlist");
    });
});

describe("unavailableModelMessage", () => {
    it("names the unavailable centrally managed provider", () => {
        expect(
            unavailableModelMessage("bedrock/us.anthropic.claude-opus-5-5", NO_KEYS),
        ).toBe("Amazon Bedrock is unavailable. Ask an administrator to check the organisation credential.");
        expect(unavailableModelMessage("gemini-3.8-flash", NO_KEYS)).toBe(
            "Google is unavailable. Ask an administrator to check the organisation credential.",
        );
    });

    it("asks to turn a switched-off provider back on instead of adding a key", () => {
        expect(
            unavailableModelMessage("xai/grok-5", {
                ...NO_KEYS,
                xai: false,
                enabled: { xai: false },
            }),
        ).toBe(
            "xAI is turned off. Turn it back on in Bring Your Own Keys before using this model.",
        );
    });
});

describe("loadWithRetry", () => {
    it("returns the value from a successful retry", async () => {
        const load = vi
            .fn()
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValueOnce("loaded");

        await expect(
            loadWithRetry(load, { delayMs: 0 }),
        ).resolves.toBe("loaded");
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("resolves null and reports the error after the final failure", async () => {
        const boom = new Error("still down");
        const load = vi.fn().mockRejectedValue(boom);
        const onFinalFailure = vi.fn();

        await expect(
            loadWithRetry(load, { delayMs: 0, onFinalFailure }),
        ).resolves.toBeNull();
        expect(load).toHaveBeenCalledTimes(2);
        expect(onFinalFailure).toHaveBeenCalledWith(boom);
    });

    it("does not retry after a success", async () => {
        const load = vi.fn().mockResolvedValue("ok");

        await expect(loadWithRetry(load, { delayMs: 0 })).resolves.toBe("ok");
        expect(load).toHaveBeenCalledTimes(1);
    });
});
