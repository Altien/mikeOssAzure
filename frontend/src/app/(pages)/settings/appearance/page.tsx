"use client";

import { useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

export default function AppearancePage() {
    const { profile, updateDarkMode, updateTransparentTables } =
        useUserProfile();
    const [savingDarkMode, setSavingDarkMode] = useState(false);
    const [savingTables, setSavingTables] = useState(false);
    const [darkModeError, setDarkModeError] = useState<string | null>(null);
    const [tablesError, setTablesError] = useState<string | null>(null);

    if (!profile) return null;

    const handleDarkModeToggle = async (enabled: boolean) => {
        if (savingDarkMode) return;
        setSavingDarkMode(true);
        setDarkModeError(null);
        try {
            await updateDarkMode(enabled);
        } catch (toggleError) {
            setDarkModeError(
                userFacingApiError(
                    toggleError,
                    "Could not update the appearance setting.",
                ),
            );
        } finally {
            setSavingDarkMode(false);
        }
    };

    const handleTablesToggle = async (liquidGlassEnabled: boolean) => {
        if (savingTables) return;
        setSavingTables(true);
        setTablesError(null);
        try {
            await updateTransparentTables(!liquidGlassEnabled);
        } catch (toggleError) {
            setTablesError(
                userFacingApiError(
                    toggleError,
                    "Could not update the table appearance setting.",
                ),
            );
        } finally {
            setSavingTables(false);
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
                        {darkModeError && (
                            <p role="alert" className="text-xs text-red-600">
                                {darkModeError}
                            </p>
                        )}
                    </div>
                    <SettingsToggle
                        checked={profile.darkMode === true}
                        loading={savingDarkMode}
                        size="md"
                        ariaLabel="Dark mode"
                        onChange={(checked) =>
                            void handleDarkModeToggle(checked)
                        }
                    />
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-gray-100 px-4 py-5">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-gray-900">
                            Liquid glass tables
                        </p>
                        <p className="text-sm text-gray-500">
                            Add a subtle liquid glass background, border, and
                            shadow to tables.
                        </p>
                        {tablesError && (
                            <p role="alert" className="text-xs text-red-600">
                                {tablesError}
                            </p>
                        )}
                    </div>
                    <SettingsToggle
                        checked={profile.transparentTables === false}
                        loading={savingTables}
                        size="md"
                        ariaLabel="Liquid glass tables"
                        onChange={(checked) =>
                            void handleTablesToggle(checked)
                        }
                    />
                </div>
            </SettingsSection>
        </section>
    );
}
