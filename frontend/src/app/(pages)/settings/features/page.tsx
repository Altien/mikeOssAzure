"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, Mail, Unlink } from "lucide-react";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    disconnectGmail,
    getGmailStatus,
    startGmailOAuth,
    type GmailStatus,
} from "@/app/lib/mikeApi";
import {
    deploymentModuleEnabled,
    featureEnabled,
    USER_FEATURE_CATALOG,
    type UserFeatureKey,
} from "@/app/lib/featureFlags";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

export default function FeaturesPage() {
    const {
        profile,
        updateApiKey,
        updateLegalResearchUs,
        updateEmailIntegration,
        updateFeatureFlag,
        updateQuickActionsVisible,
    } = useUserProfile();
    const [quickActionsError, setQuickActionsError] = useState<string | null>(
        null,
    );
    const [saving, setSaving] = useState(false);
    const [savingQuickActions, setSavingQuickActions] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [optimisticLegalResearchUs, setOptimisticLegalResearchUs] = useState<
        boolean | null
    >(null);
    const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
    const [gmailBusy, setGmailBusy] = useState(false);
    const [gmailError, setGmailError] = useState<string | null>(null);
    const [featureSaving, setFeatureSaving] = useState<UserFeatureKey | null>(
        null,
    );
    const [featureError, setFeatureError] = useState<string | null>(null);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
    const courtListenerEnabled =
        optimisticLegalResearchUs ?? persistedLegalResearchUs;
    const gmailDeploymentEnabled = profile
        ? deploymentModuleEnabled(profile.deploymentModules, "gmail")
        : false;

    const refreshGmailStatus = async () => {
        try {
            setGmailStatus(await getGmailStatus());
            setGmailError(null);
        } catch (error) {
            setGmailError(
                error instanceof Error ? error.message : "Could not load Gmail status.",
            );
        }
    };

    useEffect(() => {
        if (!profile) return;
        if (!gmailDeploymentEnabled) {
            setGmailStatus(null);
            setGmailError(null);
            return;
        }
        void refreshGmailStatus();
        const apiOrigin = new URL(
            process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
            window.location.origin,
        ).origin;
        const handleMessage = (event: MessageEvent) => {
            if (event.origin !== apiOrigin) return;
            if (event.data?.type !== "gmail_oauth_result") return;
            if (event.data.success) void refreshGmailStatus();
            else setGmailError(event.data.detail || "Gmail authorization failed.");
        };
        window.addEventListener("message", handleMessage);
        return () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            window.removeEventListener("message", handleMessage);
        };
    }, [gmailDeploymentEnabled, profile]);

    const quickActionsVisible = profile?.quickActionsVisible ?? true;

    const setQuickActionsVisible = async (visible: boolean) => {
        setQuickActionsError(null);
        setSavingQuickActions(true);
        const ok = await updateQuickActionsVisible(visible);
        setSavingQuickActions(false);
        if (!ok) setQuickActionsError("Could not update. Try again.");
    };

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

    async function handleEmailToggle(enabled: boolean) {
        if (gmailBusy || !gmailStatus?.available) return;
        setGmailBusy(true);
        setGmailError(null);
        const ok = await updateEmailIntegration(enabled);
        if (!ok) setGmailError("Could not update Email Integration.");
        await refreshGmailStatus();
        setGmailBusy(false);
    }

    async function handleConnectGmail() {
        if (gmailBusy) return;
        const popup = window.open("about:blank", "mike-gmail-oauth", "popup,width=620,height=760");
        setGmailBusy(true);
        setGmailError(null);
        try {
            const { authorizationUrl } = await startGmailOAuth();
            if (popup) popup.location.assign(authorizationUrl);
            else window.location.assign(authorizationUrl);
        } catch (error) {
            popup?.close();
            setGmailError(error instanceof Error ? error.message : "Could not start Gmail authorization.");
        } finally {
            setGmailBusy(false);
        }
    }

    async function handleDisconnectGmail() {
        if (gmailBusy) return;
        setGmailBusy(true);
        setGmailError(null);
        try {
            await disconnectGmail();
            await refreshGmailStatus();
        } catch (error) {
            setGmailError(error instanceof Error ? error.message : "Could not disconnect Gmail.");
        } finally {
            setGmailBusy(false);
        }
    }

    async function handleFeatureToggle(
        key: UserFeatureKey,
        enabled: boolean,
    ) {
        if (featureSaving) return;
        setFeatureSaving(key);
        setFeatureError(null);
        const ok = await updateFeatureFlag(key, enabled);
        if (!ok) {
            setFeatureError("Could not update that feature. Try again.");
        }
        setFeatureSaving(null);
    }

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

            {(["Workspace", "Integrations", "Models"] as const).map((group) => {
                const items = USER_FEATURE_CATALOG.filter(
                    (feature) => feature.group === group,
                );
                return (
                    <section key={group} className="space-y-3">
                        <h2 className="text-2xl font-medium font-serif text-gray-900">
                            {group}
                        </h2>
                        <SettingsSection>
                            {items.map((feature, index) => {
                                const available = profile
                                    ? deploymentModuleEnabled(
                                          profile.deploymentModules,
                                          feature.key,
                                      )
                                    : false;
                                return (
                                <div key={feature.key}>
                                    {index > 0 && (
                                        <div className="mx-4 h-px bg-gray-100" />
                                    )}
                                    <div className="flex items-start justify-between gap-4 px-4 py-5">
                                        <div className="min-w-0 space-y-1">
                                            <p className="text-sm font-medium text-gray-900">
                                                {feature.name}
                                            </p>
                                            <p className="text-sm text-gray-500">
                                                {feature.description}
                                            </p>
                                            {!available && (
                                                <p className="text-xs font-medium text-amber-700">
                                                    Not enabled for this deployment
                                                </p>
                                            )}
                                        </div>
                                        <SettingsToggle
                                            checked={featureEnabled(
                                                profile?.featureFlags,
                                                feature.key,
                                                profile?.deploymentModules,
                                            )}
                                            loading={
                                                featureSaving === feature.key
                                            }
                                            disabled={
                                                !available ||
                                                (featureSaving !== null &&
                                                    featureSaving !== feature.key)
                                            }
                                            size="md"
                                            onChange={(enabled) =>
                                                void handleFeatureToggle(
                                                    feature.key,
                                                    enabled,
                                                )
                                            }
                                        />
                                    </div>
                                </div>
                                );
                            })}
                        </SettingsSection>
                    </section>
                );
            })}

            {featureError && (
                <p className="-mt-5 text-sm text-red-600">{featureError}</p>
            )}

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
                        <ApiKeyField
                            label="CourtListener API Key"
                            placeholder="Token..."
                            hasSavedKey={
                                !!profile?.apiKeys.courtlistener.configured
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    "courtlistener",
                                    value.trim() || null,
                                )
                            }
                            onRemove={() => updateApiKey("courtlistener", null)}
                        />
                    )}
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Email Integration
                    </h2>
                </div>
                <SettingsSection>
                    <div className="px-4 py-5">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 space-y-1">
                                <div className="flex items-center gap-2">
                                    <Mail className="h-4 w-4 text-gray-500" />
                                    <p className="text-sm font-medium text-gray-900">Gmail</p>
                                </div>
                                <p className="text-sm text-gray-500">
                                    Search and attach email to Mike documents, and send material Monitor alerts.
                                </p>
                            </div>
                            <SettingsToggle
                                checked={
                                    gmailDeploymentEnabled &&
                                    profile?.emailIntegrationEnabled === true
                                }
                                disabled={
                                    !gmailDeploymentEnabled ||
                                    !gmailStatus?.available
                                }
                                loading={gmailBusy}
                                size="md"
                                onChange={(checked) => void handleEmailToggle(checked)}
                            />
                        </div>

                        {!gmailDeploymentEnabled && (
                            <p className="mt-4 text-sm text-amber-700">
                                Gmail is not enabled for this Mike deployment.
                            </p>
                        )}

                        {gmailDeploymentEnabled && gmailStatus?.available === false && (
                            <p className="mt-4 text-sm text-gray-500">
                                Gmail is not configured for this Mike instance.
                            </p>
                        )}

                        {gmailDeploymentEnabled && gmailStatus?.available && profile?.emailIntegrationEnabled && (
                            <div className="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-900">
                                        {gmailStatus.connected ? "Connected" : "Not connected"}
                                    </p>
                                    {gmailStatus.email && (
                                        <p className="truncate text-sm text-gray-500">{gmailStatus.email}</p>
                                    )}
                                </div>
                                {gmailStatus.connected ? (
                                    <button
                                        type="button"
                                        onClick={() => void handleDisconnectGmail()}
                                        disabled={gmailBusy}
                                        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-950 disabled:opacity-45"
                                    >
                                        {gmailBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                                        Disconnect
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => void handleConnectGmail()}
                                        disabled={gmailBusy}
                                        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-950 disabled:opacity-45"
                                    >
                                        {gmailBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                                        Connect Gmail
                                    </button>
                                )}
                            </div>
                        )}

                        {gmailError && <p className="mt-3 text-sm text-red-600">{gmailError}</p>}
                    </div>
                </SettingsSection>
            </section>
        </div>
    );
}
