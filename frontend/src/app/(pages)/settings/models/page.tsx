"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Loader2 } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import {
    MODELS,
    SETTINGS_MODELS,
    type ModelOption,
} from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";
import {
    FieldLabel,
} from "@/app/components/ui/form-field";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { SettingsSection } from "../SettingsSection";
import {
    useAoaiDeployments,
    type AoaiDeployment,
} from "@/altien/models/aoaiDeployments";
// Upstream divergence (sync-log: fe942475): NOT SUPPORTED — upstream
// appends local Ollama models (useOllamaModels) to both dropdowns. Dev's
// backend serves no local models, so only the static lists are offered.
// Upstream divergence (OSS-6, §2.3 item 3): both dropdowns also offer the
// discovered Azure OpenAI deployments and the Kimi group; the page adds the
// organisation-setup note and the discovered-deployments list (credentials
// are organisation Key Vault secrets, managed through /install).

type ModelPreferenceField = "titleModel" | "tabularModel";

export default function ModelPreferencesPage() {
    const { profile, updateModelPreference } = useUserProfile();
    const aoai = useAoaiDeployments();
    const [savingField, setSavingField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [savedField, setSavedField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [optimisticValues, setOptimisticValues] = useState<
        Partial<Record<ModelPreferenceField, string>>
    >({});
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        };
    }, []);

    const handleModelChange = async (
        field: ModelPreferenceField,
        id: string,
    ) => {
        setOptimisticValues((current) => ({ ...current, [field]: id }));
        setSavedField(null);
        setSavingField(field);
        const ok = await updateModelPreference(field, id);
        setSavingField((current) => (current === field ? null : current));
        if (ok) {
            setSavedField(field);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
                setSavedField((current) => (current === field ? null : current));
            }, 1600);
        } else {
            setOptimisticValues((current) => {
                const next = { ...current };
                delete next[field];
                return next;
            });
        }
    };

    return (
        <div>
            <div className="flex items-center gap-2 mb-4">
                <h2 className="text-2xl font-medium font-serif">
                    Model Preferences
                </h2>
            </div>
            <SettingsSection>
                <div className="px-4 py-5">
                    <FieldLabel className="text-sm">
                        Title generation model
                    </FieldLabel>
                    <p className="text-xs text-gray-400 mb-2">
                        Used for naming chats and other lightweight titles.
                    </p>
                    <ModelPreferenceDropdown
                        value={
                            optimisticValues.titleModel ??
                            profile?.titleModel ??
                            "gemini-3.1-flash-lite-preview"
                        }
                        options={[...SETTINGS_MODELS, ...aoai.modelOptions]}
                        extraModels={aoai.modelOptions}
                        apiKeys={profile?.apiKeys}
                        isSaving={savingField === "titleModel"}
                        isSaved={savedField === "titleModel"}
                        onChange={(id) => handleModelChange("titleModel", id)}
                    />
                </div>
                <div className="px-4 py-5">
                    <FieldLabel className="text-sm">
                        Tabular review model
                    </FieldLabel>
                    <p className="text-xs text-gray-400 mb-2">
                        We recommend using a smaller model for tabular reviews
                        to reduce token costs.
                    </p>
                    <ModelPreferenceDropdown
                        value={
                            optimisticValues.tabularModel ??
                            profile?.tabularModel ??
                            "gemini-3-flash-preview"
                        }
                        options={[...MODELS, ...aoai.modelOptions]}
                        extraModels={aoai.modelOptions}
                        apiKeys={profile?.apiKeys}
                        isSaving={savingField === "tabularModel"}
                        isSaved={savedField === "tabularModel"}
                        onChange={(id) => handleModelChange("tabularModel", id)}
                    />
                </div>
            </SettingsSection>
            <OrganisationModelsNote
                deployments={aoai.deployments}
                loading={aoai.loading}
                error={aoai.error}
            />
        </div>
    );
}

// Dev-only (OSS-6, §2.3 item 3): provider credentials and the Azure OpenAI
// connection are organisation settings; show where they are managed and
// which AOAI deployments discovery found.
function OrganisationModelsNote({
    deployments,
    loading,
    error,
}: {
    deployments: AoaiDeployment[];
    loading: boolean;
    error: string | null;
}) {
    const installUrl =
        (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") +
        "/install";
    return (
        <div className="py-6">
            <p className="max-w-xl text-sm text-gray-500">
                Provider credentials and Azure OpenAI connection settings are
                shared by the organisation and managed by an administrator
                through{" "}
                <a
                    href={installUrl}
                    className="font-medium text-gray-700 underline underline-offset-4"
                >
                    organisation setup
                </a>
                . Users can choose from the models the administrator has made
                available.
            </p>
            {loading ? (
                <p className="mt-4 max-w-xl text-xs text-gray-500">
                    Loading deployments…
                </p>
            ) : error ? (
                <p className="mt-4 max-w-xl text-xs text-red-600">
                    Could not list deployments: {error}
                </p>
            ) : deployments.length === 0 ? (
                <p className="mt-4 max-w-xl text-xs text-gray-500">
                    No deployments are visible yet. Ask an administrator to
                    check the Azure OpenAI settings in organisation setup or
                    deploy a model in the configured Azure OpenAI resource.
                </p>
            ) : (
                <div className="mt-4 max-w-xl">
                    <div className="mb-2 text-xs font-medium text-gray-600">
                        Discovered deployments ({deployments.length})
                    </div>
                    <ul className="space-y-1 text-xs text-gray-500">
                        {deployments.map((d) => (
                            <li key={d.name}>
                                <span className="font-mono text-gray-700">
                                    {d.name}
                                </span>
                                {d.model && (
                                    <span className="ml-2 text-gray-400">
                                        → {d.model}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function ModelPreferenceDropdown({
    value,
    onChange,
    apiKeys,
    options,
    extraModels,
    isSaving,
    isSaved,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    options: ModelOption[];
    extraModels?: ModelOption[];
    isSaving?: boolean;
    isSaved?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = options.find((m) => m.id === value);
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys, extraModels)
        : true;
    const groups: ModelOption["group"][] = [
        "Anthropic",
        "Google",
        "OpenAI",
        "Local",
        "Kimi",
        "Azure OpenAI",
    ];

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={isSaving}
                    className={`flex h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span className="truncate text-gray-900">
                            {selected?.label ?? "Select a model"}
                        </span>
                    </span>
                    {isSaving ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-500" />
                    ) : isSaved ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
                    ) : (
                        <ChevronDown
                            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                        />
                    )}
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map((group, gi) => {
                    const items = options.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const provider = modelGroupToProvider(m.group);
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys, extraModels)
                                    : true;
                                return (
                                    <LiquidDropdownItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={
                                            !available
                                                ? `Add a ${providerLabel(provider)} API key to use this model`
                                                : undefined
                                        }
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </LiquidDropdownItem>
                                );
                            })}
                        </div>
                    );
                })}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
