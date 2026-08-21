"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, X } from "lucide-react";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import { authInputClassName } from "@/app/components/auth/authStyles";
import { Input } from "@/app/components/ui/input";
import { OptionPill } from "@/app/components/ui/option-pill";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuRadioGroup,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownRadioItem,
} from "@/app/components/ui/liquid-dropdown";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { cn } from "@/app/lib/utils";
import {
    COUNTRY_OPTIONS,
    OTHER_JURISDICTION_OPTION,
    PRACTICE_AREA_OPTIONS,
    PRACTICE_SETTING_OPTIONS,
    PROFESSIONAL_TITLE_OPTIONS,
    type PracticeSetting,
    type ProfessionalTitle,
} from "../options";

const COMMON_PRACTICE_AREAS = PRACTICE_AREA_OPTIONS.filter(
    (area) => area !== "Other",
);
const NOT_SET_OPTION = "__not_set__";

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
            initialPracticeSetting={profile.practiceSetting ?? null}
            initialProfessionalTitle={profile.professionalTitle ?? null}
            initialAreas={common}
            initialOtherArea={custom ?? ""}
        />
    );
}

function PracticeDetailsForm({
    initialJurisdiction,
    initialPracticeSetting,
    initialProfessionalTitle,
    initialAreas,
    initialOtherArea,
}: {
    initialJurisdiction: string;
    initialPracticeSetting: PracticeSetting | null;
    initialProfessionalTitle: ProfessionalTitle | null;
    initialAreas: string[];
    initialOtherArea: string;
}) {
    const router = useRouter();
    const { completeOnboarding } = useUserProfile();
    const initialUsesOtherJurisdiction =
        !!initialJurisdiction &&
        !COUNTRY_OPTIONS.includes(
            initialJurisdiction as (typeof COUNTRY_OPTIONS)[number],
        );
    const [jurisdictionChoice, setJurisdictionChoice] = useState(
        initialUsesOtherJurisdiction
            ? OTHER_JURISDICTION_OPTION
            : initialJurisdiction,
    );
    const [otherJurisdiction, setOtherJurisdiction] = useState(
        initialUsesOtherJurisdiction ? initialJurisdiction : "",
    );
    const [practiceSetting, setPracticeSetting] =
        useState<PracticeSetting | null>(initialPracticeSetting);
    const [professionalTitle, setProfessionalTitle] =
        useState<ProfessionalTitle | null>(initialProfessionalTitle);
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
    const jurisdiction =
        jurisdictionChoice === OTHER_JURISDICTION_OPTION
            ? otherJurisdiction.trim()
            : jurisdictionChoice;

    const toggleArea = (area: string) => {
        setSelectedAreas((current) =>
            current.includes(area)
                ? current.filter((item) => item !== area)
                : [...current, area],
        );
    };

    const finishOnboarding = async (details: Parameters<typeof completeOnboarding>[0]) => {
        setSubmitting(true);
        setError(null);
        const saved = await completeOnboarding(details);
        if (saved) {
            router.replace("/assistant");
        } else {
            setError("Unable to save your practice details");
            setSubmitting(false);
        }
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (
            jurisdictionChoice === OTHER_JURISDICTION_OPTION &&
            !otherJurisdiction.trim()
        ) {
            setError("Enter your jurisdiction of practice");
            return;
        }
        if (otherSelected && !otherArea.trim()) {
            setError("Enter your other practice area");
            return;
        }

        await finishOnboarding({
            ...(jurisdiction ? { jurisdiction } : {}),
            ...(practiceSetting ? { practiceSetting } : {}),
            ...(professionalTitle ? { professionalTitle } : {}),
            ...(practiceAreas.length ? { practiceAreas } : {}),
        });
    };

    return (
        <OnboardingShell
            step="Step 2 of 2"
            title="Your legal practice"
            description="Optionally add your professional setting, primary jurisdiction, and the areas you work in."
        >
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <FieldLabel htmlFor="jurisdiction">
                        Jurisdiction of practice
                    </FieldLabel>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                id="jurisdiction"
                                type="button"
                                aria-label="Jurisdiction of practice"
                                className={cn(
                                    "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
                                    authInputClassName,
                                    !jurisdictionChoice && "text-gray-400",
                                )}
                            >
                                <span className="truncate">
                                    {jurisdictionChoice || "Select a country"}
                                </span>
                                <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                            </button>
                        </DropdownMenuTrigger>
                        <LiquidDropdownContent
                            align="start"
                            sideOffset={6}
                            className={cn(
                                "max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto",
                            )}
                        >
                            <DropdownMenuRadioGroup
                                value={jurisdictionChoice}
                                onValueChange={(value) =>
                                    setJurisdictionChoice(
                                        value === NOT_SET_OPTION ? "" : value,
                                    )
                                }
                            >
                                <LiquidDropdownRadioItem value={NOT_SET_OPTION}>
                                    Not set
                                </LiquidDropdownRadioItem>
                                {COUNTRY_OPTIONS.map((country) => (
                                    <LiquidDropdownRadioItem
                                        key={country}
                                        value={country}
                                    >
                                        {country}
                                    </LiquidDropdownRadioItem>
                                ))}
                                <LiquidDropdownRadioItem
                                    value={OTHER_JURISDICTION_OPTION}
                                >
                                    {OTHER_JURISDICTION_OPTION}
                                </LiquidDropdownRadioItem>
                            </DropdownMenuRadioGroup>
                        </LiquidDropdownContent>
                    </DropdownMenu>
                </div>

                {jurisdictionChoice === OTHER_JURISDICTION_OPTION && (
                    <div>
                        <FieldLabel htmlFor="other-jurisdiction">
                            Other jurisdiction
                        </FieldLabel>
                        <Input
                            id="other-jurisdiction"
                            value={otherJurisdiction}
                            onChange={(event) =>
                                setOtherJurisdiction(event.target.value)
                            }
                            maxLength={100}
                            placeholder="Enter your jurisdiction"
                            className={`w-full ${authInputClassName}`}
                        />
                    </div>
                )}

                <div>
                    <FieldLabel htmlFor="professional-title">
                        Title
                    </FieldLabel>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                id="professional-title"
                                type="button"
                                aria-label="Title"
                                className={cn(
                                    "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
                                    authInputClassName,
                                    !professionalTitle && "text-gray-400",
                                )}
                            >
                                <span className="truncate">
                                    {professionalTitle ?? "Select a title"}
                                </span>
                                <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                            </button>
                        </DropdownMenuTrigger>
                        <LiquidDropdownContent
                            align="start"
                            sideOffset={6}
                            className="w-[var(--radix-dropdown-menu-trigger-width)]"
                        >
                            <DropdownMenuRadioGroup
                                value={professionalTitle ?? ""}
                                onValueChange={(value) =>
                                    setProfessionalTitle(
                                        value === NOT_SET_OPTION
                                            ? null
                                            : (value as ProfessionalTitle),
                                    )
                                }
                            >
                                <LiquidDropdownRadioItem value={NOT_SET_OPTION}>
                                    Not set
                                </LiquidDropdownRadioItem>
                                {PROFESSIONAL_TITLE_OPTIONS.map((title) => (
                                    <LiquidDropdownRadioItem
                                        key={title}
                                        value={title}
                                    >
                                        {title}
                                    </LiquidDropdownRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </LiquidDropdownContent>
                    </DropdownMenu>
                </div>

                <div>
                    <FieldLabel htmlFor="practice-setting">
                        Professional setting
                    </FieldLabel>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                id="practice-setting"
                                type="button"
                                aria-label="Professional setting"
                                className={cn(
                                    "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
                                    authInputClassName,
                                    !practiceSetting && "text-gray-400",
                                )}
                            >
                                <span className="truncate">
                                    {PRACTICE_SETTING_OPTIONS.find(
                                        (option) =>
                                            option.value === practiceSetting,
                                    )?.label ?? "Select a professional setting"}
                                </span>
                                <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                            </button>
                        </DropdownMenuTrigger>
                        <LiquidDropdownContent
                            align="start"
                            sideOffset={6}
                            className="w-[var(--radix-dropdown-menu-trigger-width)]"
                        >
                            <DropdownMenuRadioGroup
                                value={practiceSetting ?? ""}
                                onValueChange={(value) =>
                                    setPracticeSetting(
                                        value === NOT_SET_OPTION
                                            ? null
                                            : (value as PracticeSetting),
                                    )
                                }
                            >
                                <LiquidDropdownRadioItem value={NOT_SET_OPTION}>
                                    Not set
                                </LiquidDropdownRadioItem>
                                {PRACTICE_SETTING_OPTIONS.map((option) => (
                                    <LiquidDropdownRadioItem
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </LiquidDropdownRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </LiquidDropdownContent>
                    </DropdownMenu>
                </div>

                <div>
                    <FieldLabel as="p">
                        Practice areas
                    </FieldLabel>
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
                        <LiquidDropdownContent
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
                        </LiquidDropdownContent>
                    </DropdownMenu>

                    {practiceAreas.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                            {selectedAreas.map((area) => (
                                <OptionPill
                                    key={area}
                                    type="button"
                                    onClick={() => toggleArea(area)}
                                    aria-label={`Remove ${area}`}
                                >
                                    {area}
                                    <X className="h-3 w-3" />
                                </OptionPill>
                            ))}
                            {otherSelected && otherArea.trim() && (
                                <OptionPill
                                    onClick={() => setOtherSelected(false)}
                                    aria-label={`Remove ${otherArea.trim()}`}
                                >
                                    {otherArea.trim()}
                                    <X className="h-3 w-3" />
                                </OptionPill>
                            )}
                        </div>
                    )}
                </div>

                {otherSelected && (
                    <div>
                        <FieldLabel htmlFor="other-practice-area">
                            Other practice area
                        </FieldLabel>
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
                    <div className="flex items-center gap-4">
                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => void finishOnboarding({})}
                            className="text-sm font-medium text-gray-500 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-300"
                        >
                            Skip
                        </button>
                        <PillButton
                            type="submit"
                            tone="black"
                            size="normal"
                            disabled={submitting}
                        >
                            {submitting ? "Finishing..." : "Finish"}
                        </PillButton>
                    </div>
                </div>
            </form>
        </OnboardingShell>
    );
}
