import type { Message } from "@/app/components/shared/types";

export interface TabularChatSettingsUpdate {
    reviewId: string;
    chatId: string;
    model?: string;
    reasoningLevel?: NonNullable<Message["reasoning"]>;
}

type Listener = (update: TabularChatSettingsUpdate) => void;

const listeners = new Set<Listener>();

export function publishTabularChatSettingsUpdate(
    update: TabularChatSettingsUpdate,
): void {
    for (const listener of listeners) listener(update);
}

export function subscribeToTabularChatSettingsUpdates(
    listener: Listener,
): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
