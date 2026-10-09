"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    hasAssistantTurn,
    subscribeAssistantTurns,
} from "@/app/lib/assistantTurns";

type AssistantHistoryStatus = "loading" | "complete";

function withAssistantHistoryStatus(
    current: Record<string, AssistantHistoryStatus>,
    chatId: string,
    status?: AssistantHistoryStatus,
) {
    if (status) {
        return current[chatId] === status
            ? current
            : { ...current, [chatId]: status };
    }
    if (!(chatId in current)) return current;
    const next = { ...current };
    delete next[chatId];
    return next;
}

export function useAssistantHistoryStatuses({
    activeChatId,
    chatIds,
    onActivity,
}: {
    activeChatId: string | null;
    chatIds: readonly string[];
    onActivity?: (chatId: string) => void;
}) {
    const activeChatIdRef = useRef(activeChatId);
    const onActivityRef = useRef(onActivity);
    const [statuses, setStatuses] = useState<
        Record<string, AssistantHistoryStatus>
    >({});

    useEffect(() => {
        activeChatIdRef.current = activeChatId;
        onActivityRef.current = onActivity;
    }, [activeChatId, onActivity]);

    useEffect(
        () =>
            subscribeAssistantTurns((chatId, change, turn) => {
                onActivityRef.current?.(chatId);
                setStatuses((current) =>
                    withAssistantHistoryStatus(
                        current,
                        chatId,
                        change === "begin"
                            ? "loading"
                            : chatId === activeChatIdRef.current ||
                                turn.assistant.error
                              ? undefined
                              : "complete",
                    ),
                );
            }),
        [],
    );

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile persisted turn state when the visible history set or selected chat changes
        setStatuses((current) => {
            let next = current;
            if (activeChatId) {
                next = withAssistantHistoryStatus(
                    next,
                    activeChatId,
                    hasAssistantTurn(activeChatId) ? "loading" : undefined,
                );
            }
            for (const chatId of chatIds) {
                if (chatId !== activeChatId && hasAssistantTurn(chatId)) {
                    next = withAssistantHistoryStatus(next, chatId, "loading");
                }
            }
            return next;
        });
    }, [activeChatId, chatIds]);

    const clearStatus = useCallback((chatId: string) => {
        setStatuses((current) =>
            withAssistantHistoryStatus(current, chatId, undefined),
        );
    }, []);

    return { statuses, clearStatus };
}
