"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, X } from "lucide-react";
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
import {
    getOpenRouterModels,
    getVercelModels,
    type ApiKeyState,
    type RouterCatalogModel,
} from "@/app/lib/mikeApi";
import {
    MODELS,
    SETTINGS_MODELS,
    openRouterModelOptions,
    vercelModelOptions,
    type ModelOption,
} from "@/app/components/assistant/ModelToggle";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { SettingsSection } from "../SettingsSection";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";

type ModelPreferenceField = "titleModel" | "tabularModel";

export default function ModelPreferencesPage() {
    const {
        profile,
        updateModelPreference,
        updateOpenRouterModels,
        updateVercelModels,
    } = useUserProfile();
    const ollamaModels = useOllamaModels();
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
    const openRouterConfigured =
        profile?.apiKeys.openrouter.configured === true;
    const vercelConfigured = profile?.apiKeys.vercel.configured === true;
    const openRouterSelection = profile?.openRouterModels ?? [];
    const vercelSelection = profile?.vercelModels ?? [];
    const selectedOpenRouterOptions =
        openRouterModelOptions(openRouterSelection);
    const selectedVercelOptions = vercelModelOptions(vercelSelection);

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
                setSavedField((current) =>
                    current === field ? null : current,
                );
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
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Model Preferences
                </h2>
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
                                "gemini-3.5-flash-lite"
                            }
                            options={[
                                ...SETTINGS_MODELS,
                                ...selectedOpenRouterOptions,
                                ...selectedVercelOptions,
                                ...ollamaModels,
                            ]}
                            apiKeys={profile?.apiKeys}
                            isSaving={savingField === "titleModel"}
                            isSaved={savedField === "titleModel"}
                            onChange={(id) =>
                                handleModelChange("titleModel", id)
                            }
                        />
                    </div>
                    <div className="px-4 py-5">
                        <FieldLabel className="text-sm">
                            Tabular review model
                        </FieldLabel>
                        <p className="text-xs text-gray-400 mb-2">
                            We recommend using a smaller model for tabular
                            reviews to reduce token costs.
                        </p>
                        <ModelPreferenceDropdown
                            value={
                                optimisticValues.tabularModel ??
                                profile?.tabularModel ??
                                "gemini-3-flash-preview"
                            }
                            options={[
                                ...MODELS,
                                ...selectedOpenRouterOptions,
                                ...selectedVercelOptions,
                                ...ollamaModels,
                            ]}
                            apiKeys={profile?.apiKeys}
                            isSaving={savingField === "tabularModel"}
                            isSaved={savedField === "tabularModel"}
                            onChange={(id) =>
                                handleModelChange("tabularModel", id)
                            }
                        />
                    </div>
                </SettingsSection>
            </section>

            {(openRouterConfigured || vercelConfigured) && (
                <section className="space-y-3">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Routers
                    </h2>
                    <SettingsSection>
                        {openRouterConfigured && (
                            <RouterModelsSetting
                                provider="openrouter"
                                label="OpenRouter"
                                selection={openRouterSelection}
                                loadCatalog={getOpenRouterModels}
                                onSave={updateOpenRouterModels}
                            />
                        )}
                        {vercelConfigured && (
                            <RouterModelsSetting
                                provider="vercel"
                                label="Vercel AI Gateway"
                                selection={vercelSelection}
                                loadCatalog={getVercelModels}
                                onSave={updateVercelModels}
                            />
                        )}
                    </SettingsSection>
                </section>
            )}
        </div>
    );
}

function RouterModelsSetting({
    provider,
    label,
    selection,
    loadCatalog,
    onSave,
}: {
    provider: "openrouter" | "vercel";
    label: string;
    selection: string[];
    loadCatalog: () => Promise<RouterCatalogModel[]>;
    onSave: (models: string[]) => Promise<boolean>;
}) {
    const [catalog, setCatalog] = useState<RouterCatalogModel[]>([]);
    const [input, setInput] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadCatalog()
            .then((models) => {
                if (!cancelled) {
                    setCatalog(models);
                    setError(null);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setCatalog([]);
                    setError(
                        `${label}'s model list could not be loaded. You can still type a model ID.`,
                    );
                }
            });
        return () => {
            cancelled = true;
        };
    }, [label, loadCatalog]);

    const save = async (next: string[]) => {
        setSaving(true);
        setError(null);
        const ok = await onSave(next);
        setSaving(false);
        if (!ok) setError(`${label} model preferences could not be saved.`);
    };

    const add = () => {
        const model = input.trim().replace(new RegExp(`^${provider}/`), "");
        if (!/^[^\s/]+\/[^\s]+$/.test(model)) {
            setError(
                `Enter a ${label} model ID such as anthropic/claude-sonnet-5.`,
            );
            return;
        }
        setInput("");
        if (!selection.includes(model)) void save([...selection, model]);
    };

    return (
        <div className="px-4 py-5">
            <div className="flex items-center gap-2">
                <FieldLabel className="text-sm">{label} models</FieldLabel>
                {saving && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                )}
            </div>
            <p className="mb-2 text-xs text-gray-400">
                Choose from {label}&apos;s catalog or type a model ID. Saved
                models appear in model selectors.
            </p>
            <div className="flex gap-2">
                <input
                    type="text"
                    list={`${provider}-model-catalog`}
                    value={input}
                    disabled={saving}
                    placeholder="e.g. anthropic/claude-sonnet-5"
                    className={`min-w-0 flex-1 ${SETTINGS_CONTROL_CLASS}`}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
                <button
                    type="button"
                    disabled={saving || !input.trim()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-default disabled:opacity-40"
                    onClick={add}
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                </button>
                <datalist id={`${provider}-model-catalog`}>
                    {catalog.map((model) => (
                        <option key={model.id} value={model.id}>
                            {model.label}
                        </option>
                    ))}
                </datalist>
            </div>
            {selection.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {selection.map((model) => (
                        <span
                            key={model}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-gray-200 bg-white/75 py-1 pl-2.5 pr-1.5 text-xs text-gray-700"
                        >
                            <span className="truncate">{model}</span>
                            <button
                                type="button"
                                disabled={saving}
                                aria-label={`Remove ${model}`}
                                className="rounded-full p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
                                onClick={() =>
                                    void save(
                                        selection.filter(
                                            (item) => item !== model,
                                        ),
                                    )
                                }
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}

function ModelPreferenceDropdown({
    value,
    onChange,
    apiKeys,
    options,
    isSaving,
    isSaved,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    options: ModelOption[];
    isSaving?: boolean;
    isSaved?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const availableOptions = options.filter((model) => {
        if (model.group === "Local") return true;
        return apiKeys ? isModelAvailable(model.id, apiKeys) : false;
    });
    const selected = availableOptions.find((model) => model.id === value);
    const groups: ModelOption["group"][] = [
        "Anthropic",
        "Google",
        "OpenAI",
        "OpenRouter",
        "Vercel AI Gateway",
        "Local",
    ];
    const availableGroups = groups.flatMap((group) => {
        const items = availableOptions.filter((model) => model.group === group);
        return items.length ? [{ group, items }] : [];
    });

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={isSaving || availableOptions.length === 0}
                    className={`flex h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
                >
                    <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-gray-900">
                            {selected?.label ??
                                (availableOptions.length
                                    ? "Select a model"
                                    : "No available models")}
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
                {availableGroups.map(({ group, items }, groupIndex) => {
                    return (
                        <div key={group}>
                            {groupIndex > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                return (
                                    <LiquidDropdownItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                    >
                                        <span className="flex-1">
                                            {m.label}
                                        </span>
                                        {m.id === value && (
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
