"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import { authInputClassName } from "@/app/components/auth/authStyles";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { updateUserProfile } from "@/app/lib/mikeApi";

export default function OnboardingProfilePage() {
    const router = useRouter();
    const { user, authLoading } = useAuth();
    const { profile, loading } = useUserProfile();

    useEffect(() => {
        if (!authLoading && !user) router.replace("/login");
    }, [authLoading, router, user]);

    if (authLoading || loading || !user || !profile) {
        return <FullScreenLoader />;
    }

    return (
        <ProfileDetailsForm
            key={user.id}
            initialName={profile.displayName ?? ""}
            initialOrganisation={profile.organisation ?? ""}
        />
    );
}

function ProfileDetailsForm({
    initialName,
    initialOrganisation,
}: {
    initialName: string;
    initialOrganisation: string;
}) {
    const router = useRouter();
    const { reloadProfile } = useUserProfile();
    const [name, setName] = useState(initialName);
    const [organisation, setOrganisation] = useState(initialOrganisation);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        const displayName = name.trim();
        if (!displayName) {
            setError("Name is required");
            return;
        }

        setSubmitting(true);
        setError(null);
        try {
            await updateUserProfile({
                displayName,
                organisation: organisation.trim() || null,
            });
            await reloadProfile();
            router.push("/onboarding/practice");
        } catch (submitError) {
            setError(
                submitError instanceof Error
                    ? submitError.message
                    : "Unable to save your details",
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <OnboardingShell
            step="Step 1 of 2"
            title="Tell us about you"
            description="Add the details we should use across Mike."
        >
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label
                        htmlFor="name"
                        className="mb-2 block text-sm font-medium text-gray-700"
                    >
                        Name
                    </label>
                    <Input
                        id="name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={200}
                        autoComplete="name"
                        required
                        className={`w-full ${authInputClassName}`}
                    />
                </div>

                <div>
                    <label
                        htmlFor="organisation"
                        className="mb-2 block text-sm font-medium text-gray-700"
                    >
                        Organisation{" "}
                        <span className="font-normal text-gray-400">
                            (optional)
                        </span>
                    </label>
                    <Input
                        id="organisation"
                        value={organisation}
                        onChange={(event) =>
                            setOrganisation(event.target.value)
                        }
                        maxLength={200}
                        autoComplete="organization"
                        className={`w-full ${authInputClassName}`}
                    />
                </div>

                {error && (
                    <div
                        className="rounded bg-red-50 p-3 text-sm text-red-600"
                        role="alert"
                    >
                        {error}
                    </div>
                )}

                <div className="pt-2">
                    <PillButton
                        type="submit"
                        tone="black"
                        size="normal"
                        disabled={submitting}
                        className="w-full"
                    >
                        {submitting ? "Saving..." : "Continue"}
                    </PillButton>
                </div>
            </form>
        </OnboardingShell>
    );
}
