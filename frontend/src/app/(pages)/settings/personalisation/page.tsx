"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { SettingsSection } from "../SettingsSection";
import { authInputClassName } from "@/app/components/auth/authStyles";
import { Input } from "@/app/components/ui/input";
import { OptionPill } from "@/app/components/ui/option-pill";
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
} from "@/app/onboarding/options";

const COMMON_PRACTICE_AREAS = PRACTICE_AREA_OPTIONS.filter(
    (area) => area !== "Other",
);

type PersonalisationField =
    | "professionalTitle"
    | "practiceSetting"
    | "jurisdiction"
    | "otherJurisdiction"
    | "practiceAreas"
    | "otherPracticeArea";

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
        <PersonalisationForm
            initialJurisdiction={profile.jurisdiction ?? ""}
            initialPracticeSetting={profile.practiceSetting ?? null}
            initialProfessionalTitle={profile.professionalTitle ?? null}
            initialAreas={common}
            initialOtherArea={custom ?? ""}
        />
    );
}

function PersonalisationForm({
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
    const { updatePersonalisation } = useUserProfile();
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
    const [pendingField, setPendingField] =
        useState<PersonalisationField | null>(null);
    const [savingField, setSavingField] =
        useState<PersonalisationField | null>(null);
    const [savedField, setSavedField] =
        useState<PersonalisationField | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [retryVersion, setRetryVersion] = useState(0);
    const initialSnapshot = JSON.stringify({
        jurisdiction: initialJurisdiction || null,
        practiceSetting: initialPracticeSetting,
        professionalTitle: initialProfessionalTitle,
        practiceAreas: [
            ...initialAreas,
            ...(initialOtherArea ? [initialOtherArea] : []),
        ],
    });
    const persistedSnapshotRef = useRef(initialSnapshot);
    const latestSnapshotRef = useRef(initialSnapshot);
    const saveChainRef = useRef<Promise<void>>(Promise.resolve());
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const personalisationDetails = useMemo(
        () => ({
            jurisdiction: jurisdiction || null,
            practiceSetting,
            professionalTitle,
            practiceAreas,
        }),
        [jurisdiction, practiceAreas, practiceSetting, professionalTitle],
    );

    const markFieldChanged = (field: PersonalisationField) => {
        setPendingField(field);
        setError(null);
    };

    const toggleArea = (area: string) => {
        setSelectedAreas((current) =>
            current.includes(area)
                ? current.filter((item) => item !== area)
                : [...current, area],
        );
        markFieldChanged("practiceAreas");
    };

    useEffect(() => {
        const snapshot = JSON.stringify(personalisationDetails);
        latestSnapshotRef.current = snapshot;
        if (
            !pendingField ||
            (jurisdictionChoice === OTHER_JURISDICTION_OPTION &&
                !otherJurisdiction.trim()) ||
            (otherSelected && !otherArea.trim()) ||
            snapshot === persistedSnapshotRef.current
        ) {
            return;
        }

        const field = pendingField;
        const timeout = setTimeout(() => {
            saveChainRef.current = saveChainRef.current.then(async () => {
                setSavingField(field);
                setSavedField(null);
                setError(null);
                const success =
                    await updatePersonalisation(personalisationDetails);
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
                if (savedTimerRef.current) {
                    clearTimeout(savedTimerRef.current);
                }
                savedTimerRef.current = setTimeout(() => {
                    setSavedField((current) =>
                        current === field ? null : current,
                    );
                }, 2000);
            });
        }, 400);

        return () => clearTimeout(timeout);
    }, [
        jurisdictionChoice,
        otherArea,
        otherJurisdiction,
        otherSelected,
        pendingField,
        personalisationDetails,
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
                    <div className="space-y-8 p-4">
                        <ProfileDropdown
                            id="professional-title"
                            label="Title"
                            allowUnset
                            status={fieldStatus(
                                "professionalTitle",
                                savingField,
                                savedField,
                            )}
                            value={professionalTitle}
                            placeholder="Select a title"
                            options={PROFESSIONAL_TITLE_OPTIONS.map((title) => ({
                                value: title,
                                label: title,
                            }))}
                            onChange={(value) => {
                                setProfessionalTitle(
                                    value
                                        ? (value as ProfessionalTitle)
                                        : null,
                                );
                                markFieldChanged("professionalTitle");
                            }}
                        />

                        <ProfileDropdown
                            id="practice-setting"
                            label="Professional setting"
                            allowUnset
                            status={fieldStatus(
                                "practiceSetting",
                                savingField,
                                savedField,
                            )}
                            value={practiceSetting}
                            placeholder="Select a professional setting"
                            options={[...PRACTICE_SETTING_OPTIONS]}
                            onChange={(value) => {
                                setPracticeSetting(
                                    value ? (value as PracticeSetting) : null,
                                );
                                markFieldChanged("practiceSetting");
                            }}
                        />

                        <ProfileDropdown
                            id="jurisdiction"
                            label="Jurisdiction of practice"
                            allowUnset
                            status={fieldStatus(
                                "jurisdiction",
                                savingField,
                                savedField,
                            )}
                            value={jurisdictionChoice || null}
                            placeholder="Select a country"
                            options={[
                                ...COUNTRY_OPTIONS.map((country) => ({
                                    value: country,
                                    label: country,
                                })),
                                {
                                    value: OTHER_JURISDICTION_OPTION,
                                    label: OTHER_JURISDICTION_OPTION,
                                },
                            ]}
                            onChange={(value) => {
                                setJurisdictionChoice(value);
                                markFieldChanged("jurisdiction");
                            }}
                            maxHeight
                        />

                        {jurisdictionChoice ===
                            OTHER_JURISDICTION_OPTION && (
                            <div>
                                <FieldLabelRow
                                    label="Other jurisdiction"
                                    htmlFor="other-jurisdiction"
                                    status={fieldStatus(
                                        "otherJurisdiction",
                                        savingField,
                                        savedField,
                                    )}
                                />
                                <Input
                                    id="other-jurisdiction"
                                    value={otherJurisdiction}
                                    onChange={(event) => {
                                        setOtherJurisdiction(
                                            event.target.value,
                                        );
                                        markFieldChanged(
                                            "otherJurisdiction",
                                        );
                                    }}
                                    maxLength={100}
                                    placeholder="Enter your jurisdiction"
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>
                        )}

                        <div>
                            <FieldLabelRow
                                label="Practice areas"
                                status={fieldStatus(
                                    "practiceAreas",
                                    savingField,
                                    savedField,
                                )}
                            />
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label="Practice areas"
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
                                            checked={selectedAreas.includes(
                                                area,
                                            )}
                                            onCheckedChange={() =>
                                                toggleArea(area)
                                            }
                                            onSelect={(event) =>
                                                event.preventDefault()
                                            }
                                        >
                                            {area}
                                        </DropdownMenuCheckboxItem>
                                    ))}
                                    <DropdownMenuCheckboxItem
                                        checked={otherSelected}
                                        onCheckedChange={(checked) => {
                                            setOtherSelected(checked === true);
                                            markFieldChanged("practiceAreas");
                                        }}
                                        onSelect={(event) =>
                                            event.preventDefault()
                                        }
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
                                            onClick={() => {
                                                setOtherSelected(false);
                                                markFieldChanged(
                                                    "practiceAreas",
                                                );
                                            }}
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
                                <FieldLabelRow
                                    label="Other practice area"
                                    htmlFor="other-practice-area"
                                    status={fieldStatus(
                                        "otherPracticeArea",
                                        savingField,
                                        savedField,
                                    )}
                                />
                                <Input
                                    id="other-practice-area"
                                    value={otherArea}
                                    onChange={(event) => {
                                        setOtherArea(event.target.value);
                                        markFieldChanged(
                                            "otherPracticeArea",
                                        );
                                    }}
                                    maxLength={100}
                                    placeholder="Enter your practice area"
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>
                        )}

                        {error && (
                            <div
                                className="flex items-center justify-end gap-2 text-xs"
                                aria-live="polite"
                            >
                                <>
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
                                </>
                            </div>
                        )}
                    </div>
                </SettingsSection>
            </section>
        </div>
    );
}

function ProfileDropdown({
    id,
    label,
    allowUnset = false,
    status,
    value,
    placeholder,
    options,
    onChange,
    maxHeight = false,
}: {
    id: string;
    label: string;
    allowUnset?: boolean;
    status: string | null;
    value: string | null;
    placeholder: string;
    options: readonly { value: string; label: string }[];
    onChange: (value: string) => void;
    maxHeight?: boolean;
}) {
    const notSetValue = "__not_set__";
    return (
        <div>
            <FieldLabelRow label={label} htmlFor={id} status={status} />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        id={id}
                        type="button"
                        aria-label={label}
                        className={cn(
                            "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
                            authInputClassName,
                            !value && "text-gray-400",
                        )}
                    >
                        <span className="truncate">
                            {options.find((option) => option.value === value)
                                ?.label ?? placeholder}
                        </span>
                        <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                    </button>
                </DropdownMenuTrigger>
                <LiquidDropdownContent
                    align="start"
                    sideOffset={6}
                    className={cn(
                        "w-[var(--radix-dropdown-menu-trigger-width)]",
                        maxHeight && "max-h-72 overflow-y-auto",
                    )}
                >
                    <DropdownMenuRadioGroup
                        value={value ?? ""}
                        onValueChange={(nextValue) =>
                            onChange(
                                nextValue === notSetValue ? "" : nextValue,
                            )
                        }
                    >
                        {allowUnset && (
                            <LiquidDropdownRadioItem value={notSetValue}>
                                Not set
                            </LiquidDropdownRadioItem>
                        )}
                        {options.map((option) => (
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
    );
}

function FieldLabelRow({
    label,
    htmlFor,
    status,
}: {
    label: string;
    htmlFor?: string;
    status: string | null;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            {htmlFor ? (
                <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
            ) : (
                <FieldLabel as="p">{label}</FieldLabel>
            )}
            <span className="text-xs text-gray-400" aria-live="polite">
                {status ?? ""}
            </span>
        </div>
    );
}
