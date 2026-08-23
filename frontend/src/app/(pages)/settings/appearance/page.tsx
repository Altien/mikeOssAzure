"use client";

import { useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

export default function AppearancePage() {
    const { profile, updateDarkMode } = useUserProfile();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!profile) return null;

    const handleToggle = async (enabled: boolean) => {
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
            await updateDarkMode(enabled);
        } catch (toggleError) {
            setError(
                userFacingApiError(
                    toggleError,
                    "Could not update the appearance setting.",
                ),
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="space-y-3">
            <h2 className="font-serif text-2xl font-medium text-gray-900">
                Appearance
            </h2>
            <SettingsSection>
                <div className="flex items-center justify-between gap-4 px-4 py-5">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-gray-900">
                            Dark mode
                        </p>
                        <p className="text-sm text-gray-500">
                            Use a darker color palette throughout Mike.
                        </p>
                        {error && (
                            <p role="alert" className="text-xs text-red-600">
                                {error}
                            </p>
                        )}
                    </div>
                    <SettingsToggle
                        checked={profile.darkMode === true}
                        loading={saving}
                        size="md"
                        onChange={(checked) => void handleToggle(checked)}
                    />
                </div>
            </SettingsSection>
        </section>
    );
}
