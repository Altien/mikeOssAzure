"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import {
    LiquidDropdownButton,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { FieldLabel } from "@/app/components/ui/form-field";
import { PillButton } from "@/app/components/ui/pill-button";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getOpenRouterModels,
    getVercelModels,
    type RouterCatalogModel,
} from "@/app/lib/mikeApi";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";

const COST_FORMATTER = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
});

function formatPerMillion(value?: string): string | null {
    if (value === undefined) return null;
    const amount = Number(value) * 1_000_000;
    return Number.isFinite(amount) && amount >= 0
        ? COST_FORMATTER.format(amount)
        : null;
}

function modelCostLabel(model: RouterCatalogModel): string | null {
    if (!model.pricing) return null;
    const input = formatPerMillion(model.pricing.input);
    const output = formatPerMillion(model.pricing.output);
    const costs = [
        input ? `${input}/M input` : null,
        output ? `${output}/M output` : null,
    ].filter(Boolean);
    if (costs.length === 0) return null;
    if (model.pricing.tiered) costs.push("tiered pricing");
    if (model.pricing.variesByProvider) costs.push("varies by provider");
    return costs.join(" · ");
}

export function RouterSettingsSection() {
    const {
        profile,
        updateOpenRouterModels,
        updateVercelModels,
    } = useUserProfile();
    const openRouterConfigured =
        profile?.apiKeys.openrouter.configured === true;
    const vercelConfigured = profile?.apiKeys.vercel.configured === true;

    if (!openRouterConfigured && !vercelConfigured) return null;

    return (
        <section className="space-y-3">
            <h2 className="text-2xl font-medium font-serif text-gray-900">
                Routers
            </h2>
            <SettingsSection>
                {openRouterConfigured && (
                    <RouterModelsSetting
                        provider="openrouter"
                        label="OpenRouter"
                        selection={profile?.openRouterModels ?? []}
                        loadCatalog={getOpenRouterModels}
                        onSave={updateOpenRouterModels}
                    />
                )}
                {vercelConfigured && (
                    <RouterModelsSetting
                        provider="vercel"
                        label="Vercel AI Gateway"
                        selection={profile?.vercelModels ?? []}
                        loadCatalog={getVercelModels}
                        onSave={updateVercelModels}
                    />
                )}
            </SettingsSection>
        </section>
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
    const [catalogOpen, setCatalogOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const typeaheadRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let cancelled = false;
        loadCatalog()
            .then((models) => {
                if (!cancelled) {
                    setCatalog(models);
                    setError(null);
                    if (inputRef.current?.value.trim()) {
                        setCatalogOpen(true);
                    }
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

    useEffect(() => {
        if (!catalogOpen) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                !typeaheadRef.current?.contains(event.target)
            ) {
                setCatalogOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setCatalogOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsidePointer);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [catalogOpen]);

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
        setCatalogOpen(false);
        if (!selection.includes(model)) void save([...selection, model]);
    };

    const visibleCatalog = catalog.filter((model) => {
        const query = input.trim().toLowerCase();
        return (
            !query ||
            model.id.toLowerCase().includes(query) ||
            model.label.toLowerCase().includes(query)
        );
    });

    const selectCatalogModel = (model: string) => {
        setInput("");
        setCatalogOpen(false);
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
            <div ref={typeaheadRef} className="relative">
                {catalogOpen && (
                    <LiquidDropdownSurface
                        data-testid={`${provider}-model-catalog`}
                        role="listbox"
                        aria-label={`${label} model catalog`}
                        className="absolute bottom-full left-0 z-50 mb-1.5 max-h-72 w-full overflow-y-auto p-1.5"
                    >
                        {visibleCatalog.length > 0 ? (
                            visibleCatalog.map((model) => {
                                const selected = selection.includes(model.id);
                                const costLabel = modelCostLabel(model);
                                return (
                                    <LiquidDropdownButton
                                        key={model.id}
                                        role="option"
                                        aria-selected={selected}
                                        onMouseDown={(event) =>
                                            event.preventDefault()
                                        }
                                        onClick={() =>
                                            selectCatalogModel(model.id)
                                        }
                                        className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-gray-700">
                                                {model.label}
                                            </span>
                                            {model.label !== model.id && (
                                                <span className="block truncate text-[10px] text-gray-400">
                                                    {model.id}
                                                </span>
                                            )}
                                            {costLabel && (
                                                <span className="block truncate text-[10px] text-gray-400">
                                                    {costLabel}
                                                </span>
                                            )}
                                        </span>
                                        {selected && (
                                            <Check className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                                        )}
                                    </LiquidDropdownButton>
                                );
                            })
                        ) : (
                            <div className="px-3 py-2 text-xs text-gray-400">
                                No matching models. Press Enter to add this
                                model ID.
                            </div>
                        )}
                    </LiquidDropdownSurface>
                )}
                <div
                    className={`flex h-9 min-w-0 flex-1 items-center px-0 focus-within:border-gray-200 focus-within:ring-2 focus-within:ring-gray-300/45 ${SETTINGS_CONTROL_CLASS}`}
                >
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        disabled={saving}
                        placeholder="e.g. anthropic/claude-sonnet-5"
                        className="h-full min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed"
                        onChange={(event) => {
                            setInput(event.target.value);
                            if (catalog.length > 0) setCatalogOpen(true);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                add();
                            }
                        }}
                    />
                    <button
                        type="button"
                        disabled={saving || catalog.length === 0}
                        aria-label={`Choose a ${label} model`}
                        aria-expanded={catalogOpen}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setCatalogOpen((open) => !open)}
                        className="flex h-full shrink-0 items-center justify-end text-gray-400 transition-colors hover:text-gray-700 disabled:cursor-default disabled:opacity-40"
                    >
                        <ChevronDown
                            className={`h-3.5 w-3.5 transition-transform duration-200 ${catalogOpen ? "rotate-180" : ""}`}
                        />
                    </button>
                </div>
            </div>
            {selection.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {selection.map((model) => (
                        <PillButton
                            key={model}
                            tone="white"
                            size="sm"
                            disabled={saving}
                            aria-label={`Remove ${model}`}
                            title={`Remove ${model}`}
                            className="max-w-full font-normal"
                            onClick={() =>
                                void save(
                                    selection.filter(
                                        (item) => item !== model,
                                    ),
                                )
                            }
                        >
                            <span className="truncate">{model}</span>
                            <X className="h-3 w-3 shrink-0 text-gray-400" />
                        </PillButton>
                    ))}
                </div>
            )}
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}
