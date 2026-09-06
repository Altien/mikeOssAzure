export interface BrowserSpeechCallbacks {
    onEnd: () => void;
    onError: (error: SpeechSynthesisErrorEvent) => void;
}

/**
 * Speak text using the browser's local speech engine.
 *
 * Returns a cancellation function so React owners can stop narration during
 * unmounts or when replacing the current utterance.
 */
export function speakWithBrowser(
    text: string,
    callbacks: BrowserSpeechCallbacks,
): () => void {
    if (
        typeof window === "undefined" ||
        typeof window.speechSynthesis === "undefined" ||
        typeof SpeechSynthesisUtterance === "undefined"
    ) {
        throw new Error("Text-to-speech is not supported by this browser.");
    }

    const utterance = new SpeechSynthesisUtterance(text);
    let active = true;

    utterance.onend = () => {
        if (!active) return;
        active = false;
        callbacks.onEnd();
    };
    utterance.onerror = (event) => {
        if (!active) return;
        active = false;
        callbacks.onError(event);
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);

    return () => {
        if (!active) return;
        active = false;
        window.speechSynthesis.cancel();
    };
}
