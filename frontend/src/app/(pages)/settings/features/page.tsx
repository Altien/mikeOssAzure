"use client";
import { WebSearchSection } from "@/app/components/settings/WebSearchSection";

import { useState } from "react";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

export default function FeaturesPage() {
  const {
    profile,
    updateLegalResearchUs,
    updateQuickActionsVisible,
    updateResponseDetailsVisible,
  } = useUserProfile();
  const [saving, setSaving] = useState(false);
  const [savingQuickActions, setSavingQuickActions] = useState(false);
  const [savingResponseDetails, setSavingResponseDetails] = useState(false);
  const [optimisticLegalResearchUs, setOptimisticLegalResearchUs] = useState<
    boolean | null
  >(null);

  const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
  const courtListenerEnabled =
    optimisticLegalResearchUs ?? persistedLegalResearchUs;
  const quickActionsVisible = profile?.quickActionsVisible ?? true;
  const responseDetailsVisible = profile?.responseDetailsVisible ?? false;

    const setQuickActionsVisible = async (visible: boolean) => {
        setSavingQuickActions(true);
        await updateQuickActionsVisible(visible);
        setSavingQuickActions(false);
    };
    const courtListenerConfigured =
        !!profile?.apiKeys.courtlistener.configured;
    const installUrl =
        (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") +
        "/install";

  const setResponseDetailsVisible = async (visible: boolean) => {
    setSavingResponseDetails(true);
    // As with quick actions, the profile context reports a failure and the
    // toggle, which reads the profile, stays where it was.
    await updateResponseDetailsVisible(visible);
    setSavingResponseDetails(false);
  };

  const handleCourtListenerChange = async (enabled: boolean) => {
    if (saving) return;
    setOptimisticLegalResearchUs(enabled);
    setSaving(true);
    // A failure is reported by the profile context's notice (with Retry);
    // dropping the optimistic value puts the toggle back.
    await updateLegalResearchUs(enabled);
    setSaving(false);
    setOptimisticLegalResearchUs(null);
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>Assistant</SettingsHeading>
        <GlassCardUI>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Quick actions</SettingsLabel>
              <SettingsDescription>
                Show the quick actions row on the assistant start screen.
              </SettingsDescription>
            </div>
            <ToggleSwitchUI
              checked={quickActionsVisible}
              disabled={savingQuickActions}
              aria-busy={savingQuickActions}
              aria-label="Quick actions"
              onCheckedChange={(checked) => {
                void setQuickActionsVisible(checked);
              }}
            />
          </SettingsRow>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Response details</SettingsLabel>
              <SettingsDescription>
                Show the model, reasoning effort and token count under each
                response and subagent.
              </SettingsDescription>
            </div>
            <ToggleSwitchUI
              checked={responseDetailsVisible}
              disabled={savingResponseDetails}
              aria-busy={savingResponseDetails}
              aria-label="Response details"
              onCheckedChange={(checked) => {
                void setResponseDetailsVisible(checked);
              }}
            />
          </SettingsRow>
        </GlassCardUI>
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
            <WebSearchSection />
        </div>
    );
}
