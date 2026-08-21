"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, X } from "lucide-react";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import { authInputClassName } from "@/app/components/auth/authStyles";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { cn } from "@/app/lib/utils";
import { COUNTRY_OPTIONS, PRACTICE_AREA_OPTIONS } from "../options";

const COMMON_PRACTICE_AREAS = PRACTICE_AREA_OPTIONS.filter(
    (area) => area !== "Other",
);

export default function OnboardingPracticePage() {
    const router = useRouter();
    const { user, authLoading } = useAuth();
    const { profile, loading } = useUserProfile();

    useEffect(() => {
        if (!authLoading && !user) router.replace("/login");
    }, [authLoading, router, user]);

    if (authLoading || loading || !user || !profile) {
        return <FullScreenLoader />;
    }

    const common = profile.practiceAreas.filter((area) =>
        COMMON_PRACTICE_AREAS.includes(
            area as (typeof COMMON_PRACTICE_AREAS)[number],
        ),
    );
    const custom = profile.practiceAreas.find(
        (area) =>
            !COMMON_PRACTICE_AREAS.includes(
                area as (typeof COMMON_PRACTICE_AREAS)[number],
            ),
    );

    return (
        <PracticeDetailsForm
            key={user.id}
            initialJurisdiction={profile.jurisdiction ?? ""}
            initialAreas={common}
            initialOtherArea={custom ?? ""}
        />
    );
}

function PracticeDetailsForm({
    initialJurisdiction,
    initialAreas,
    initialOtherArea,
}: {
    initialJurisdiction: string;
    initialAreas: string[];
    initialOtherArea: string;
}) {
    const router = useRouter();
    const { completeOnboarding } = useUserProfile();
    const [jurisdiction, setJurisdiction] = useState(initialJurisdiction);
    const [selectedAreas, setSelectedAreas] = useState(initialAreas);
    const [otherSelected, setOtherSelected] = useState(!!initialOtherArea);
    const [otherArea, setOtherArea] = useState(initialOtherArea);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const practiceAreas = useMemo(
        () => [
            ...selectedAreas,
            ...(otherSelected && otherArea.trim() ? [otherArea.trim()] : []),
        ],
        [otherArea, otherSelected, selectedAreas],
    );

    const toggleArea = (area: string) => {
        setSelectedAreas((current) =>
            current.includes(area)
                ? current.filter((item) => item !== area)
                : [...current, area],
        );
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!jurisdiction) {
            setError("Select your jurisdiction of practice");
            return;
        }
        if (otherSelected && !otherArea.trim()) {
            setError("Enter your other practice area");
            return;
        }
        if (practiceAreas.length === 0) {
            setError("Select at least one practice area");
            return;
        }

        setSubmitting(true);
        setError(null);
        const saved = await completeOnboarding(jurisdiction, practiceAreas);
        if (saved) {
            router.replace("/assistant");
        } else {
            setError("Unable to save your practice details");
            setSubmitting(false);
        }
    };

    return (
        <OnboardingShell
            step="Step 2 of 2"
            title="Your legal practice"
            description="Choose your primary jurisdiction and the areas you work in."
        >
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label
                        htmlFor="jurisdiction"
                        className="mb-2 block text-sm font-medium text-gray-700"
                    >
                        Jurisdiction of practice
                    </label>
                    <div className="relative">
                        <select
                            id="jurisdiction"
                            value={jurisdiction}
                            onChange={(event) =>
                                setJurisdiction(event.target.value)
                            }
                            required
                            className={cn(
                                "h-9 w-full appearance-none pr-9 text-sm outline-none",
                                authInputClassName,
                                !jurisdiction && "text-gray-400",
                            )}
                        >
                            <option value="" disabled>
                                Select a country
                            </option>
                            {COUNTRY_OPTIONS.map((country) => (
                                <option key={country} value={country}>
                                    {country}
                                </option>
                            ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    </div>
                </div>

                <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                        Practice areas
                    </label>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={cn(
                                    "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
                                    authInputClassName,
                                    practiceAreas.length === 0 &&
                                        "text-gray-400",
                                )}
                            >
                                <span className="truncate">
                                    {practiceAreas.length
                                        ? `${practiceAreas.length} selected`
                                        : "Select practice areas"}
                                </span>
                                <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            align="start"
                            sideOffset={6}
                            className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
                        >
                            {COMMON_PRACTICE_AREAS.map((area) => (
                                <DropdownMenuCheckboxItem
                                    key={area}
                                    checked={selectedAreas.includes(area)}
                                    onCheckedChange={() => toggleArea(area)}
                                    onSelect={(event) => event.preventDefault()}
                                >
                                    {area}
                                </DropdownMenuCheckboxItem>
                            ))}
                            <DropdownMenuCheckboxItem
                                checked={otherSelected}
                                onCheckedChange={(checked) =>
                                    setOtherSelected(checked === true)
                                }
                                onSelect={(event) => event.preventDefault()}
                            >
                                Other
                            </DropdownMenuCheckboxItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {practiceAreas.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                            {selectedAreas.map((area) => (
                                <button
                                    key={area}
                                    type="button"
                                    onClick={() => toggleArea(area)}
                                    className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-200"
                                    aria-label={`Remove ${area}`}
                                >
                                    {area}
                                    <X className="h-3 w-3" />
                                </button>
                            ))}
                            {otherSelected && otherArea.trim() && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                                    <Check className="h-3 w-3" />
                                    {otherArea.trim()}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {otherSelected && (
                    <div>
                        <label
                            htmlFor="other-practice-area"
                            className="mb-2 block text-sm font-medium text-gray-700"
                        >
                            Other practice area
                        </label>
                        <Input
                            id="other-practice-area"
                            value={otherArea}
                            onChange={(event) =>
                                setOtherArea(event.target.value)
                            }
                            maxLength={100}
                            placeholder="Enter your practice area"
                            className={`w-full ${authInputClassName}`}
                        />
                    </div>
                )}

                {error && (
                    <div
                        className="rounded bg-red-50 p-3 text-sm text-red-600"
                        role="alert"
                    >
                        {error}
                    </div>
                )}

                <div className="flex items-center justify-between gap-3 pt-2">
                    <PillButton
                        type="button"
                        tone="white"
                        size="normal"
                        disabled={submitting}
                        onClick={() => router.push("/onboarding/profile")}
                    >
                        Back
                    </PillButton>
                    <PillButton
                        type="submit"
                        tone="black"
                        size="normal"
                        disabled={submitting}
                    >
                        {submitting ? "Finishing..." : "Finish"}
                    </PillButton>
                </div>
            </form>
        </OnboardingShell>
    );
}
