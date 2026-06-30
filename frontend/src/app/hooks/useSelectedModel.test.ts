import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSelectedModel } from "./useSelectedModel";
import { DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";

const STORAGE_KEY = "mike.selectedModel";

describe("useSelectedModel: initial state", () => {
    it("returns the default model when nothing is stored", () => {
        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe(DEFAULT_MODEL_ID);
    });

    it("hydrates from localStorage after the effect runs", () => {
        // The hook's useState initial value is the default, then the
        // effect synchronously reads localStorage and overwrites.
        window.localStorage.setItem(STORAGE_KEY, "claude-opus-4-7");

        const { result } = renderHook(() => useSelectedModel());

        expect(result.current[0]).toBe("claude-opus-4-7");
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

        act(() => {
            result.current[1]("gpt-5.5");
        });

        expect(result.current[0]).toBe("gpt-5.5");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe("gpt-5.5");
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
