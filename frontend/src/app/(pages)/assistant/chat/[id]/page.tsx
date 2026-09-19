"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { getChat } from "@/app/lib/mikeApi";
import { usePathParams } from "@/app/lib/usePathParams";
import { can, roleFrom } from "@/app/lib/permissions";
import type { Chat } from "@/app/components/shared/types";

export default function AssistantChatPage() {
    const router = useRouter();
    // Static-export divergence (OSS-6): id from the live URL, not
    // useParams() (always "_" under output: "export"). layout.tsx only
    // mounts this page once the id is non-empty.
    const { id } = usePathParams<"id">("/assistant/chat/:id");

    const { setCurrentChatId, newChatMessages, setNewChatMessages } =
        useChatHistoryContext();

    const initialMessages = newChatMessages ?? [];
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        cancel,
        rejectedApiKey,
        dismissInvalidApiKey,
    } = useAssistantChat({ initialMessages, chatId: id });

    const hasAutoSent = useRef(false);
    const hasLoaded = useRef(false);
    // Whether the caller may write here, from the standing GET /chat/:id
    // serves. Grant-reachable chats appear in the global sidebar since the
    // parity change, so a project VIEWER can land on this page — dropping
    // the served role handed them a live composer whose sends 403. Arriving
    // via "new chat" means the caller just created the thread: creator.
    //
    // Fail-closed until the served standing lands: `false` on every cold
    // load, which used to read "Viewing only — sending needs edit access" at
    // a chat's own owner. `accessResolved` below is what keeps that false
    // from being shown as an accusation — the composer is not rendered at
    // all until the answer arrives. A failed getChat leaves it false and
    // redirects.
    const [canSend, setCanSend] = useState<boolean>(
        initialMessages.length > 0,
    );
    // Until the served role lands, the standing is unknown rather than
    // denied. Keep the composer off the page for that window so a caller who
    // does have edit access never reads the read-only placeholder; arriving
    // from "new chat" already knows the answer.
    const [accessResolved, setAccessResolved] = useState<boolean>(
        initialMessages.length > 0,
    );
    const [chat, setChat] = useState<Chat | null>(null);
    const [chatModel, setChatModel] = useState<string | null | undefined>(
        initialMessages.length > 0
            ? (initialMessages[0]?.model ?? null)
            : undefined,
    );
    const [chatReasoningLevel, setChatReasoningLevel] = useState<
        NonNullable<(typeof initialMessages)[number]["reasoning"]> | null | undefined
    >(
        initialMessages.length > 0
            ? (initialMessages[0]?.reasoning ?? null)
            : undefined,
    );

    useEffect(() => {
        setCurrentChatId(id);
    }, [id, setCurrentChatId]);

    useEffect(() => {
        if (initialMessages.length > 0) {
            if (newChatMessages) setNewChatMessages(null);
            return;
        }
        if (hasLoaded.current || messages.length > 0) return;
        hasLoaded.current = true;

        getChat(id)
            .then(({ chat, messages: loaded }) => {
                setChat(chat);
                setChatModel(chat.model ?? null);
                setChatReasoningLevel(chat.reasoning_level ?? null);
                setCanSend(can(roleFrom(chat), "content.edit"));
                setAccessResolved(true);
                if (loaded.length > 0) {
                    setMessages(loaded);
                } else {
                    router.replace("/assistant");
                }
            })
            .catch(() => router.replace("/assistant"));
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (
            newChatMessages &&
            newChatMessages.length === 1 &&
            newChatMessages[0].role === "user" &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <ChatView
            chatId={id}
            chat={chat}
            chatModel={chatModel}
            chatReasoningLevel={chatReasoningLevel}
            messages={messages}
            rejectedApiKey={rejectedApiKey}
            onDismissInvalidApiKey={dismissInvalidApiKey}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            canSend={canSend}
            accessResolved={accessResolved}
        />
    );
}
