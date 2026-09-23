import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeText } = vi.hoisted(() => ({
    completeText: vi.fn(),
}));

vi.mock("../../../lib/llm", () => ({ completeText }));

import { generateAssistantChatTitle, logChatTitleFailure } from "../chat.title";
import { UserFacingError } from "../../../lib/userFacingError";

describe("logChatTitleFailure", () => {
    // console.error is what the Sentry console bridge files; console.warn is
    // not. A provider refusal of the title also fails the reply, which
    // reports it — so logging it at error level filed it twice (MIKE-BACKEND-D).
    it("keeps provider refusals and missing keys out of error level", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const apiCallError = Object.assign(new Error("API key not valid"), {
            name: "AI_APICallError",
            statusCode: 400,
        });
        const retryError = Object.assign(new Error("retries exhausted"), {
            name: "AI_RetryError",
            lastError: Object.assign(new Error("overloaded"), { statusCode: 529 }),
        });
        logChatTitleFailure("[t]", apiCallError);
        logChatTitleFailure("[t]", retryError);
        logChatTitleFailure("[t]", new UserFacingError("Gemini API key required"));
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(3);
        error.mockRestore();
        warn.mockRestore();
    });

    it("still logs anything else — a failed title write, a bug — as an error", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const bug = new TypeError("cannot read properties of undefined");
        logChatTitleFailure("[t]", bug);
        expect(error).toHaveBeenCalledWith("[t]", bug);
        error.mockRestore();
    });
});

describe("generateAssistantChatTitle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("normalizes and returns the generated title", async () => {
        completeText.mockResolvedValue('  "German Liquidity Review."  ');

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Review the company liquidity position",
                apiKeys: {},
            }),
        ).resolves.toBe("German Liquidity Review");
        expect(completeText).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "title-model",
                maxTokens: 64,
                apiKeys: {},
            }),
        );
    });

    it("uses the fallback for an empty model response", async () => {
        completeText.mockResolvedValue("   ");

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Hello",
            }),
        ).resolves.toBe("Misc. Query");
    });

    it("limits generated titles to 80 characters", async () => {
        completeText.mockResolvedValue("x".repeat(100));

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Hello",
            }),
        ).resolves.toBe("x".repeat(80));
    });
});
