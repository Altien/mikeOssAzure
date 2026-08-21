"use client";

import { useEffect, useRef, useState } from "react";
import { SettingsSection } from "../SettingsSection";
import {
    PersonalisationFields,
    personalisationInitialValues,
    type PersonalisationField,
    usePersonalisationFields,
} from "@/app/components/settings/PersonalisationFields";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

function fieldStatus(
    field: PersonalisationField,
    savingField: PersonalisationField | null,
    savedField: PersonalisationField | null,
) {
    if (savingField === field) return "Saving...";
    if (savedField === field) return "Saved";
    return null;
}

export default function PersonalisationPage() {
    const { profile } = useUserProfile();
    if (!profile) return null;

    return (
        <PersonalisationForm
            initial={personalisationInitialValues(profile)}
        />
    );
}

function PersonalisationForm({
    initial,
}: {
    initial: ReturnType<typeof personalisationInitialValues>;
}) {
    const { updatePersonalisation } = useUserProfile();
    const [pendingField, setPendingField] =
        useState<PersonalisationField | null>(null);
    const [savingField, setSavingField] =
        useState<PersonalisationField | null>(null);
    const [savedField, setSavedField] =
        useState<PersonalisationField | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [retryVersion, setRetryVersion] = useState(0);
    const form = usePersonalisationFields(initial, (field) => {
        setPendingField(field);
        setError(null);
    });
    const initialSnapshot = JSON.stringify({
        jurisdiction: initial.jurisdiction || null,
        practiceSetting: initial.practiceSetting,
        professionalTitle: initial.professionalTitle,
        practiceAreas: initial.practiceAreas,
    });
    const persistedSnapshotRef = useRef(initialSnapshot);
    const latestSnapshotRef = useRef(initialSnapshot);
    const saveChainRef = useRef<Promise<void>>(Promise.resolve());
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const snapshot = JSON.stringify(form.details);
        latestSnapshotRef.current = snapshot;
        if (
            !pendingField ||
            form.validationError ||
            snapshot === persistedSnapshotRef.current
        ) {
            return;
        }

        const field = pendingField;
        const details = form.details;
        const timeout = setTimeout(() => {
            saveChainRef.current = saveChainRef.current.then(async () => {
                setSavingField(field);
                setSavedField(null);
                setError(null);
                const success = await updatePersonalisation(details);
                if (success) persistedSnapshotRef.current = snapshot;
                setSavingField((current) =>
                    current === field ? null : current,
                );
                if (latestSnapshotRef.current !== snapshot) return;
                if (!success) {
                    setError("Unable to save your personalisation settings");
                    return;
                }
                setSavedField(field);
                if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
                savedTimerRef.current = setTimeout(() => {
                    setSavedField((current) =>
                        current === field ? null : current,
                    );
                }, 2000);
            });
        }, 400);

        return () => clearTimeout(timeout);
    }, [
        form.details,
        form.validationError,
        pendingField,
        retryVersion,
        updatePersonalisation,
    ]);

    useEffect(
        () => () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        },
        [],
    );

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="font-serif text-2xl font-medium text-gray-900">
                    Personalisation
                </h2>
                <p className="text-sm text-gray-500">
                    Tell Mike about your role and practice so responses can be
                    tailored to your professional context.
                </p>
                <SettingsSection>
                    <div className="p-4">
                        <PersonalisationFields
                            form={form}
                            className="space-y-8"
                            practiceAreasAriaLabel="Practice areas"
                            statusFor={(field) =>
                                fieldStatus(field, savingField, savedField)
                            }
                        />

                        {error && (
                            <div
                                className="mt-8 flex items-center justify-end gap-2 text-xs"
                                aria-live="polite"
                            >
                                <span className="text-red-600" role="alert">
                                    {error}
                                </span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setRetryVersion(
                                            (current) => current + 1,
                                        )
                                    }
                                    className="font-medium text-gray-700 hover:text-gray-950"
                                >
                                    Retry
                                </button>
                            </div>
                        )}
                    </div>
                </SettingsSection>
            </section>
        </div>
    );
}
