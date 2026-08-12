"use client";

/**
 * GitHub skill-acquisition settings on the account Connectors page
 * (dev-only, OSS-6 §2.3 item 7).
 *
 * Self-contained so upstream's `account/connectors/page.tsx` carries only a
 * one-line hook-in: loads the tenant policy, lets a TenantAdmin allow/deny
 * GitHub imports, and connect/disconnect the private-repository OAuth
 * connection (through the shared `oauthPopup` ritual). Errors surface
 * through the page's `onError` banner.
 */

import { useCallback, useEffect, useState } from "react";
import {
    disconnectGitHubSkillOAuth,
    getGitHubSkillImportPolicy,
    setGitHubSkillImportPolicy,
    startGitHubSkillOAuth,
    type GitHubSkillImportPolicy,
} from "./api";
import { openOAuthPopup } from "@/app/(pages)/settings/connectors/oauthPopup";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";
import { SettingsToggle } from "@/app/(pages)/settings/SettingsToggle";
import { settingsGlassPrimaryButtonClassName } from "@/app/(pages)/settings/settingsStyles";

// Dev-only: upstream's settings refactor (317a8f05) dropped the shared
// danger-button class; this dev component keeps its own.
const settingsGlassDangerButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-red-600 shadow-none transition-colors hover:bg-red-50 hover:text-red-700 active:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45";

function errorText(err: unknown, fallback: string) {
    return err instanceof Error ? err.message : fallback;
}

export function GitHubSkillImportSection({
    onError,
}: {
    onError: (message: string | null) => void;
}) {
    const [policy, setPolicy] = useState<GitHubSkillImportPolicy | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getGitHubSkillImportPolicy()
            .then((next) => {
                if (!cancelled) setPolicy(next);
            })
            .catch(() => {
                // No policy (e.g. skills routes unavailable): hide the section.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const run = useCallback(
        (action: () => Promise<void>, fallback: string) => {
            setBusy(true);
            onError(null);
            void action()
                .catch((err) => onError(errorText(err, fallback)))
                .finally(() => setBusy(false));
        },
        [onError],
    );

    const connect = async () => {
        const popup = openOAuthPopup(
            "mike_github_skill_oauth",
            "popup,width=680,height=760,menubar=no,toolbar=no,location=yes,status=no",
        );
        try {
            const { authorizationUrl } = await startGitHubSkillOAuth();
            if (!authorizationUrl) {
                throw new Error(
                    "GitHub OAuth authorization URL was not returned.",
                );
            }
            const outcome = await popup.wait({
                authorizationUrl,
                messageType: "github_skill_oauth_result",
                timedOutMessage: "GitHub authorization timed out.",
                closedMessage: "GitHub authorization window was closed.",
                failedMessage: "GitHub authorization failed.",
            });
            if (outcome === "redirected") return;
            setPolicy(await getGitHubSkillImportPolicy());
        } catch (err) {
            popup.close();
            throw err;
        }
    };

    if (!policy) return null;

    return (
        <SettingsSection className="p-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-sm font-medium text-gray-900">
                        GitHub skill acquisition
                    </h3>
                    <p className="mt-1 text-sm text-gray-500">
                        Allow TenantAdmins to import bounded, commit-pinned
                        skill snapshots from github.com.
                    </p>
                    {!policy.deploymentAllowed && (
                        <p className="mt-2 text-xs text-amber-700">
                            Denied by the deployment-wide policy.
                        </p>
                    )}
                    <p className="mt-2 text-xs text-gray-500">
                        Private repository connection:{" "}
                        {policy.privateRepositoryConnectionConfigured
                            ? `connected${policy.githubLogin ? ` as ${policy.githubLogin}` : ""}`
                            : "not configured"}
                    </p>
                    {policy.canManage && policy.oauthAvailable && (
                        <div className="mt-3 flex gap-2">
                            {!policy.privateRepositoryConnectionConfigured ? (
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                        run(connect, "GitHub connection failed.")
                                    }
                                    className={`inline-flex h-9 items-center gap-1.5 text-sm ${settingsGlassPrimaryButtonClassName}`}
                                >
                                    Connect GitHub
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                        run(async () => {
                                            await disconnectGitHubSkillOAuth();
                                            setPolicy(
                                                await getGitHubSkillImportPolicy(),
                                            );
                                        }, "GitHub disconnect failed.")
                                    }
                                    className={settingsGlassDangerButtonClassName}
                                >
                                    Disconnect GitHub
                                </button>
                            )}
                        </div>
                    )}
                    {!policy.oauthAvailable && (
                        <p className="mt-2 text-xs text-amber-700">
                            GitHub OAuth is not configured for this deployment.
                        </p>
                    )}
                </div>
                <SettingsToggle
                    checked={policy.tenantEnabled}
                    disabled={!policy.deploymentAllowed || !policy.canManage}
                    loading={busy}
                    label={policy.tenantEnabled ? "Allowed" : "Denied"}
                    onChange={(enabled) =>
                        run(async () => {
                            setPolicy(await setGitHubSkillImportPolicy(enabled));
                        }, "Failed to update GitHub policy.")
                    }
                />
            </div>
        </SettingsSection>
    );
}
