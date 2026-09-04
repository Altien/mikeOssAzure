"use client";

import { useCallback, useEffect, useState } from "react";
import { AccessModal } from "@/app/components/modals/AccessModal";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    getChatAccess,
    getChatPeople,
    grantChatAccess,
    revokeChatAccess,
    type ContentAccess,
} from "@/app/lib/mikeApi";
import { can, roleFrom } from "@/app/lib/permissions";
import type { Chat } from "@/app/components/shared/types";

interface Props {
    open: boolean;
    chat: Chat;
    onClose: () => void;
}

export function ChatAccessModal({ open, chat, onClose }: Props) {
    const { user } = useAuth();
    const [accessState, setAccessState] = useState<{
        chatId: string;
        value: ContentAccess;
    } | null>(null);
    const access =
        accessState?.chatId === chat.id ? accessState.value : null;
    const canManage = can(roleFrom(chat), "access.manage");

    const refreshAccess = useCallback(async () => {
        const nextAccess = await getChatAccess(chat.id);
        setAccessState({ chatId: chat.id, value: nextAccess });
    }, [chat.id]);

    useEffect(() => {
        if (!open || !canManage) return;
        let cancelled = false;
        getChatAccess(chat.id)
            .then((nextAccess) => {
                if (!cancelled) {
                    setAccessState({ chatId: chat.id, value: nextAccess });
                }
            })
            .catch(() => {
                // The people roster remains useful if the management-only
                // access request fails. Controls stay disabled until it succeeds.
            });
        return () => {
            cancelled = true;
        };
    }, [canManage, chat.id, open]);

    return (
        <AccessModal
            open={open}
            onClose={onClose}
            resource={{
                id: chat.id,
                owner_display_name: chat.creator_display_name ?? null,
            }}
            fetchAccess={getChatPeople}
            currentUserEmail={user?.email ?? null}
            breadcrumb={[
                "Assistant",
                chat.title?.trim() || "Untitled chat",
                "Access",
            ]}
            access={{
                grants: access?.grants ?? [],
                orgId: access?.org_id ?? chat.org_id ?? null,
                inheritedFromProjectId:
                    access?.inherited_from_project_id ??
                    chat.project_id ??
                    null,
                ownerLabel: "Owners",
                canManage: canManage && access !== null,
                onGrant: async (email, role) => {
                    await grantChatAccess(chat.id, email, role);
                    await refreshAccess();
                },
                onRevoke: async (email) => {
                    await revokeChatAccess(chat.id, email);
                    await refreshAccess();
                },
            }}
        />
    );
}
