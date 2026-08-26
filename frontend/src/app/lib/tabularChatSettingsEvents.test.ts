import { describe, expect, it, vi } from "vitest";
import {
    publishTabularChatSettingsUpdate,
    subscribeToTabularChatSettingsUpdates,
} from "./tabularChatSettingsEvents";

describe("tabularChatSettingsEvents", () => {
    it("publishes chat-specific model and reasoning updates", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToTabularChatSettingsUpdates(listener);

        publishTabularChatSettingsUpdate({
            reviewId: "review-1",
            chatId: "chat-1",
            model: "gpt-5.6-terra",
        });
        publishTabularChatSettingsUpdate({
            reviewId: "review-1",
            chatId: "chat-1",
            reasoningLevel: "low",
        });

        expect(listener).toHaveBeenNthCalledWith(1, {
            reviewId: "review-1",
            chatId: "chat-1",
            model: "gpt-5.6-terra",
        });
        expect(listener).toHaveBeenNthCalledWith(2, {
            reviewId: "review-1",
            chatId: "chat-1",
            reasoningLevel: "low",
        });

        unsubscribe();
        publishTabularChatSettingsUpdate({
            reviewId: "review-1",
            chatId: "chat-1",
            model: "gpt-5.5",
        });
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
