"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

export default function FeaturesPage() {
    const { profile, updateLegalResearchUs, updateQuickActionsVisible } = useUserProfile();
    const [quickActionsError, setQuickActionsError] = useState<string | null>(
        null,
    );
    const [saving, setSaving] = useState(false);
    const [savingQuickActions, setSavingQuickActions] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [optimisticLegalResearchUs, setOptimisticLegalResearchUs] = useState<
        boolean | null
    >(null);

    const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
    const courtListenerEnabled =
        optimisticLegalResearchUs ?? persistedLegalResearchUs;
    const quickActionsVisible = profile?.quickActionsVisible ?? true;

    const setQuickActionsVisible = async (visible: boolean) => {
        setQuickActionsError(null);
        setSavingQuickActions(true);
        const ok = await updateQuickActionsVisible(visible);
        setSavingQuickActions(false);
        if (!ok) setQuickActionsError("Could not update. Try again.");
    };
    const courtListenerConfigured =
        !!profile?.apiKeys.courtlistener.configured;
    const installUrl =
        (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") +
        "/install";

    const handleCourtListenerChange = async (enabled: boolean) => {
        if (saving) return;
        setSaveError(null);
        setOptimisticLegalResearchUs(enabled);
        setSaving(true);
        const ok = await updateLegalResearchUs(enabled);
        setSaving(false);
        setOptimisticLegalResearchUs(null);
        if (!ok) {
            setSaveError("Could not update. Try again.");
        }
    };

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Assistant
                    </h2>
                </div>
                <SettingsSection>
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Quick actions
                            </p>
                            <p className="text-sm text-gray-500">
                                Show the quick actions row on the assistant
                                start screen.
                            </p>
                            {quickActionsError && (
                                <p className="text-sm text-red-600">
                                    {quickActionsError}
                                </p>
                            )}
                        </div>
                        <SettingsToggle
                            checked={quickActionsVisible}
                            loading={savingQuickActions}
                            size="md"
                            onChange={(checked) => {
                                void setQuickActionsVisible(checked);
                            }}
                        />
                    </div>
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Legal Research
                    </h2>
                </div>
                <SettingsSection>
                    <div className="flex items-center justify-between gap-3 px-4 py-5">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Enable CourtListener
                            </p>
                            <p className="text-sm text-gray-500">
                                CourtListener provides access to US case law.
                            </p>
                        </div>
                        <SettingsToggle
                            checked={courtListenerEnabled}
                            loading={saving}
                            size="md"
                            onChange={(enabled) =>
                                void handleCourtListenerChange(enabled)
                            }
                        />
                    </div>
                    {saveError && (
                        <p className="px-4 pb-4 text-sm text-red-600">
                            {saveError}
                        </p>
                    )}
                    {courtListenerEnabled && (
                        // Upstream divergence (OSS-6, §2.3 item 3): dev stores
                        // CourtListener as an organisation Key Vault secret;
                        // the backend intentionally rejects personal key writes.
                        <div className="border-t border-gray-200 px-4 py-5">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-sm font-medium text-gray-700">
                                        CourtListener API key
                                    </p>
                                    <p className="mt-1 text-xs text-gray-500">
                                        Key Vault: courtlistener-api-token
                                    </p>
                                </div>
                                <div
                                    className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${
                                        courtListenerConfigured
                                            ? "text-emerald-700"
                                            : "text-amber-700"
                                    }`}
                                >
                                    {courtListenerConfigured ? (
                                        <CheckCircle2 className="h-4 w-4" />
                                    ) : (
                                        <AlertTriangle className="h-4 w-4" />
                                    )}
                                    {profile === null
                                        ? "Checking..."
                                        : courtListenerConfigured
                                          ? "Configured for this organisation"
                                          : "Administrator action required"}
                                </div>
                            </div>
                            <a
                                href={installUrl}
                                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 underline underline-offset-4 hover:text-gray-950"
                            >
                                Open organisation setup
                                <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                        </div>
                    )}
                </SettingsSection>
            </section>
        </div>
    );
}
