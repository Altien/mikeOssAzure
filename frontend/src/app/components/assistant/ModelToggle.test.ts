import { describe, expect, it } from "vitest";
import {
    modelDisplayName,
    openRouterModelOptions,
    vercelModelOptions,
} from "./ModelToggle";

describe("model display names", () => {
    it("formats provider model identifiers as readable names", () => {
        expect(modelDisplayName("anthropic/claude-sonnet-4-6")).toBe(
            "Claude Sonnet 4.6",
        );
        expect(
            modelDisplayName("openrouter/meta-llama/llama-3-3-70b-instruct"),
        ).toBe("Llama 3.3 70B Instruct");
    });

    it("uses the readable name for OpenRouter toggle options", () => {
        expect(openRouterModelOptions(["openai/gpt-4o-mini"])[0]).toMatchObject(
            {
                id: "openrouter/openai/gpt-4o-mini",
                label: "GPT 4o Mini",
            },
        );
    });

    it("uses the readable name for Vercel AI Gateway toggle options", () => {
        expect(vercelModelOptions(["openai/gpt-5.4"])[0]).toMatchObject({
            id: "vercel/openai/gpt-5.4",
            label: "GPT 5.4",
            group: "OpenAI",
            source: "Vercel AI Gateway",
        });
    });
});
