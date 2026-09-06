import { afterEach, describe, expect, it, vi } from "vitest";
import { speakWithBrowser } from "./browserSpeech";

class MockUtterance {
    onend: (() => void) | null = null;
    onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

    constructor(readonly text: string) {}
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("speakWithBrowser", () => {
    it("speaks locally and reports completion", () => {
        const cancel = vi.fn();
        const speak = vi.fn();
        const onEnd = vi.fn();
        const onError = vi.fn();
        vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
        Object.defineProperty(window, "speechSynthesis", {
            configurable: true,
            value: { cancel, speak },
        });

        const stop = speakWithBrowser("Hello from Mike", { onEnd, onError });

        expect(cancel).toHaveBeenCalledOnce();
        expect(speak).toHaveBeenCalledOnce();
        const utterance = speak.mock.calls[0][0] as MockUtterance;
        expect(utterance.text).toBe("Hello from Mike");
        utterance.onend?.();
        expect(onEnd).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();

        stop();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("cancels an active utterance", () => {
        const cancel = vi.fn();
        vi.stubGlobal("SpeechSynthesisUtterance", MockUtterance);
        Object.defineProperty(window, "speechSynthesis", {
            configurable: true,
            value: { cancel, speak: vi.fn() },
        });

        const stop = speakWithBrowser("Stop me", {
            onEnd: vi.fn(),
            onError: vi.fn(),
        });
        stop();

        expect(cancel).toHaveBeenCalledTimes(2);
    });

    it("fails intentionally when the browser has no speech engine", () => {
        vi.stubGlobal("SpeechSynthesisUtterance", undefined);
        Object.defineProperty(window, "speechSynthesis", {
            configurable: true,
            value: undefined,
        });

        expect(() =>
            speakWithBrowser("Hello", {
                onEnd: vi.fn(),
                onError: vi.fn(),
            }),
        ).toThrow("Text-to-speech is not supported by this browser.");
    });
});
