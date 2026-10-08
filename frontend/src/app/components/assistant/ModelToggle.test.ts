import { describe, expect, it } from "vitest";
import {
    azureModelOptions,
    bedrockCatalogModel,
    bedrockModelOptions,
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

describe("cloud platform options", () => {
    it("reads Bedrock ids as vendor/model without AWS-only decoration", () => {
        expect(bedrockCatalogModel("us.anthropic.claude-opus-5-5")).toBe(
            "anthropic/claude-opus-5-5",
        );
        expect(
            bedrockCatalogModel("anthropic.claude-sonnet-4-5-20250929-v1:0"),
        ).toBe("anthropic/claude-sonnet-4-5");
        expect(
            bedrockCatalogModel(
                "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
            ),
        ).toBe("anthropic/claude-opus-5-5");
        expect(bedrockCatalogModel("meta.llama4-maverick-17b-instruct-v1:0")).toBe(
            "meta/llama4-maverick-17b-instruct",
        );
        // An id that is not vendor.model is shown as typed.
        expect(bedrockCatalogModel("my-application-profile")).toBe(
            "my-application-profile",
        );
    });

    it("groups Bedrock models by maker and keeps the id verbatim", () => {
        expect(bedrockModelOptions(["us.anthropic.claude-opus-5-5"])[0]).toEqual({
            id: "bedrock/us.anthropic.claude-opus-5-5",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Amazon Bedrock",
        });
    });

    it("labels Azure deployments by name", () => {
        expect(azureModelOptions(["gpt-6.1-sol"])[0]).toEqual({
            id: "azure/gpt-6.1-sol",
            label: "GPT 6.1 Sol",
            group: "OpenAI",
            source: "Azure OpenAI",
        });
    });
});
