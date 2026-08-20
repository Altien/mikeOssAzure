import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSelectedModel } from "./useSelectedModel";
import { canonicalModelId, DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";

const STORAGE_KEY = "mike.selectedModel";

beforeEach(() => {
    window.localStorage.clear();
});

describe("useSelectedModel", () => {
    it("canonicalizes stored ids before validating them", () => {
        // The current LEGACY_MODEL_IDS targets are settings-tier models, so
        // after mapping they still resolve to the composer default here — the
        // mapping's user-visible effect lives on the settings page. This
        // pins that reads go through canonicalModelId (a future rename of a
        // composer-tier model is then handled for free).
        window.localStorage.setItem(STORAGE_KEY, "gpt-5.4-lite");

        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe("gemini-3-flash-preview");
    });

    it("persists a valid explicit selection", () => {
        const { result } = renderHook(() => useSelectedModel());

        act(() => result.current[1]("claude-fable-5"));

        expect(result.current[0]).toBe("claude-fable-5");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe("claude-fable-5");
    });

    it("keeps a router selection that is in the loaded saved lists", () => {
        window.localStorage.setItem(STORAGE_KEY, "openrouter/openai/gpt-5.4");

        const { result } = renderHook(() =>
            useSelectedModel({
                openRouterModels: ["openai/gpt-5.4"],
                vercelModels: [],
                openCodeGoModels: [],
            }),
        );

        expect(result.current[0]).toBe("openrouter/openai/gpt-5.4");
    });

    it("resets a router selection missing from the loaded saved lists", () => {
        window.localStorage.setItem(STORAGE_KEY, "openrouter/pricy/frontier");

        const { result } = renderHook(() =>
            useSelectedModel({
                openRouterModels: ["openai/gpt-5.4"],
                vercelModels: [],
                openCodeGoModels: [],
            }),
        );

        expect(result.current[0]).toBe("gemini-3-flash-preview");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
            "gemini-3-flash-preview",
        );
    });

    it("keeps an OpenCode Go selection that is in the loaded saved lists", () => {
        window.localStorage.setItem(STORAGE_KEY, "opencode-go/glm-5");

        const { result } = renderHook(() =>
            useSelectedModel({
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: ["glm-5"],
            }),
        );

        expect(result.current[0]).toBe("opencode-go/glm-5");
    });

    it("resets an OpenCode Go selection the user no longer has saved", () => {
        window.localStorage.setItem(STORAGE_KEY, "opencode-go/kimi-k3");

        const { result } = renderHook(() =>
            useSelectedModel({
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: ["glm-5"],
            }),
        );

        expect(result.current[0]).toBe("gemini-3-flash-preview");
    });

    it("leaves a router selection alone while the lists are still loading", () => {
        window.localStorage.setItem(STORAGE_KEY, "openrouter/openai/gpt-5.4");

        const { result } = renderHook(() => useSelectedModel(null));

        expect(result.current[0]).toBe("openrouter/openai/gpt-5.4");
    });
});

describe("canonicalModelId", () => {
    it("maps only known legacy ids", () => {
        expect(canonicalModelId("gemini-3.1-flash-lite-preview")).toBe(
            "gemini-3.5-flash-lite",
        );
        expect(canonicalModelId("gpt-5.4-lite")).toBe("gpt-5.4-mini");
        expect(canonicalModelId("claude-fable-5")).toBe("claude-fable-5");
    });
});

describe("useSelectedModel: initial state", () => {
    it("returns the default model when nothing is stored", () => {
        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe(DEFAULT_MODEL_ID);
    });

    it("hydrates from localStorage after the effect runs", () => {
        // The hook's useState initial value is the default, then the
        // effect synchronously reads localStorage and overwrites.
        window.localStorage.setItem(STORAGE_KEY, "claude-fable-5");

        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe("claude-fable-5");
    });

    it("rejects a stored value that is not in ALLOWED_MODEL_IDS", () => {
        // Defensive: if the stored value is a model that no longer
        // exists (renamed, removed, or never valid), we fall back to
        // the default instead of trusting the storage.
        window.localStorage.setItem(STORAGE_KEY, "gpt-9000-imaginary");

        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe(DEFAULT_MODEL_ID);
    });

    it("accepts an aoai: prefixed model id (deployment names are user-defined)", () => {
        // AOAI deployments validate by prefix, not the static set —
        // the user's customised deployment name "prod-east" is fine.
        window.localStorage.setItem(STORAGE_KEY, "aoai:prod-east");

        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe("aoai:prod-east");
    });
});

describe("useSelectedModel: setter", () => {
    it("updates state and persists to localStorage", () => {
        const { result } = renderHook(() => useSelectedModel());

        // aoai:-prefixed ids are always allowed, so this stays valid as
        // the static model list churns.
        act(() => {
            result.current[1]("aoai:prod-east");
        });

        expect(result.current[0]).toBe("aoai:prod-east");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe("aoai:prod-east");
    });

    it("normalises an invalid id to the default — both state and storage", () => {
        // Symmetrical with the read-time guard: setting an unknown
        // id clamps to the default, so the storage cannot drift into
        // an invalid state via a buggy caller.
        const { result } = renderHook(() => useSelectedModel());

        act(() => {
            result.current[1]("not-a-real-model");
        });

        expect(result.current[0]).toBe(DEFAULT_MODEL_ID);
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(DEFAULT_MODEL_ID);
    });

    it("accepts any aoai: prefixed id without checking against a list", () => {
        const { result } = renderHook(() => useSelectedModel());

        act(() => {
            result.current[1]("aoai:custom-deployment-name");
        });

        expect(result.current[0]).toBe("aoai:custom-deployment-name");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
            "aoai:custom-deployment-name",
        );
    });

    it("returns a stable setter across renders", () => {
        // useCallback with [] deps — important for downstream useEffect
        // dependency arrays that include setModel.
        const { result, rerender } = renderHook(() => useSelectedModel());
        const firstSetter = result.current[1];

        rerender();

        expect(result.current[1]).toBe(firstSetter);
    });
});
