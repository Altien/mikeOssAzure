"use client";

/**
 * Skill runtime for a project chat (dev-only, OSS-6 §2.3 item 7).
 *
 * A project chat may be bound to an approved skill version. The chat page
 * shows the binding next to the chat title and, when a newer enabled
 * version exists, an explicit upgrade banner. Mike never upgrades on its
 * own: `upgrade()` applies exactly the version the member was shown.
 *
 * Hooked into upstream's `[chatId]/page.tsx` with: one hook call, one
 * `setBinding` in the `getChat` handler, the chip in the title breadcrumb
 * and the banner above the three-panel body.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
    getChatSkillBinding,
    upgradeChatSkill,
    type ChatDetailSkillBinding,
    type ChatSkillBinding,
} from "./api";

export type ChatSkillRuntime = {
    binding: ChatDetailSkillBinding | null;
    setBinding: (binding: ChatDetailSkillBinding | null) => void;
    availableUpgrade: ChatSkillBinding["availableUpgrade"];
    upgrading: boolean;
    upgradeError: string | null;
    upgrade: () => Promise<void>;
};

export function useChatSkillRuntime(
    projectId: string,
    chatId: string,
): ChatSkillRuntime {
    const [binding, setBinding] = useState<ChatDetailSkillBinding | null>(
        null,
    );
    const [availableUpgrade, setAvailableUpgrade] =
        useState<ChatSkillBinding["availableUpgrade"]>(null);
    const [upgrading, setUpgrading] = useState(false);
    const [upgradeError, setUpgradeError] = useState<string | null>(null);

    // Only a bound chat asks whether a newer enabled version exists.
    useEffect(() => {
        if (!projectId || !chatId || !binding) return;
        let cancelled = false;
        getChatSkillBinding(projectId, chatId)
            .then(({ binding: current }) => {
                if (!cancelled)
                    setAvailableUpgrade(current?.availableUpgrade ?? null);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [projectId, chatId, binding]);

    const upgrade = useCallback(async () => {
        if (!projectId || !chatId || !availableUpgrade) return;
        setUpgrading(true);
        setUpgradeError(null);
        try {
            const upgraded = await upgradeChatSkill(
                projectId,
                chatId,
                availableUpgrade.versionId,
            );
            setBinding((current) =>
                current
                    ? {
                          ...current,
                          versionId: upgraded.versionId,
                          contentHash: upgraded.contentHash,
                      }
                    : current,
            );
            setAvailableUpgrade(null);
        } catch (error) {
            setUpgradeError(
                error instanceof Error
                    ? error.message
                    : "The skill could not be upgraded.",
            );
        } finally {
            setUpgrading(false);
        }
    }, [projectId, chatId, availableUpgrade]);

    return {
        binding,
        setBinding,
        availableUpgrade,
        upgrading,
        upgradeError,
        upgrade,
    };
}

/** The bound skill, shown next to the chat title. */
export function ChatSkillChip({
    binding,
}: {
    binding: ChatDetailSkillBinding | null;
}) {
    if (!binding) return null;
    return (
        <span
            className="ml-2 rounded-full bg-violet-50 px-2 py-1 text-xs text-violet-700"
            title={`Skill version ${binding.versionId}; content ${binding.contentHash}`}
        >
            Skill: {binding.displayName} · {binding.contentHash.slice(0, 8)}
        </span>
    );
}

/** Explicit, visible skill upgrade. Never automatic. */
export function ChatSkillUpgradeBanner({
    runtime,
}: {
    runtime: ChatSkillRuntime;
}) {
    const { binding, availableUpgrade, upgrading, upgradeError, upgrade } =
        runtime;
    if (!binding || !availableUpgrade) return null;
    return (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-violet-100 bg-violet-50 px-4 py-2 text-xs text-violet-800">
            <span>
                <strong>{binding.displayName}</strong> has a newer approved
                version. This chat keeps running version{" "}
                {binding.contentHash.slice(0, 8)} until you upgrade it.
                {upgradeError && (
                    <span className="ml-2 text-red-600">{upgradeError}</span>
                )}
            </span>
            <button
                onClick={() => void upgrade()}
                disabled={upgrading}
                title={`Upgrade this chat to version ${availableUpgrade.versionId} (content ${availableUpgrade.contentHash})`}
                className="flex items-center gap-1 rounded-full bg-violet-600 px-3 py-1 text-xs text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
            >
                {upgrading && <Loader2 className="h-3 w-3 animate-spin" />}
                Upgrade
            </button>
        </div>
    );
}
