import { describe, expect, it } from "vitest";
import {
    getModelProvider,
    isModelAvailable,
    providerLabel,
} from "./modelAvailability";

describe("Kimi K3 model availability", () => {
    it("maps kimi-k3 to Kimi and enables it only for the organisation key", () => {
        const unavailable = {
            claudeApiKey: null,
            geminiApiKey: null,
            openaiApiKey: null,
            globalApiKeys: {
                claude: false,
                gemini: false,
                openai: false,
                kimi: false,
                azureOpenai: false,
            },
        };

        expect(getModelProvider("kimi-k3")).toBe("kimi");
        expect(providerLabel("kimi")).toBe("Kimi K3");
        expect(isModelAvailable("kimi-k3", unavailable)).toBe(false);
        expect(
            isModelAvailable("kimi-k3", {
                ...unavailable,
                globalApiKeys: {
                    ...unavailable.globalApiKeys,
                    kimi: true,
                },
            }),
        ).toBe(true);
    });
});
