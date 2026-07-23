"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
    providerLabel,
    type ApiKeyAvailability,
} from "@/app/lib/modelAvailability";

export default function ModelsAndApiKeysPage() {
    const {
        profile,
        updateModelPreference,
        aoaiDeployments,
        aoaiDeploymentsLoading,
        aoaiDeploymentsError,
    } = useUserProfile();

    // Build dynamic AOAI model entries for the picker. Label uses the
    // deployment name first (it's what the customer recognises), with
    // the underlying base model as a hint when AOAI exposes one.
    const aoaiModelEntries = aoaiDeployments.map((d) => ({
        id: `aoai:${d.name}`,
        label: d.model ? `${d.name} (${d.model})` : d.name,
        group: "Azure OpenAI" as const,
    }));

    return (
        <div className="space-y-4">
            {/* Model Preferences */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Fast model{" "}
                            <span className="text-gray-400">
                                (used for chat titles and column-prompt
                                suggestions)
                            </span>
                        </label>
                        <ModelPreferenceDropdown
                            value={profile?.fastModel ?? null}
                            apiKeys={{
                                claudeApiKey: profile?.claudeApiKey ?? null,
                                geminiApiKey: profile?.geminiApiKey ?? null,
                                openaiApiKey: profile?.openaiApiKey ?? null,
                                globalApiKeys: profile?.globalApiKeys,
                            }}
                            extraModels={aoaiModelEntries}
                            placeholder="Auto (cheapest configured)"
                            onChange={(id) =>
                                updateModelPreference("fastModel", id)
                            }
                        />
                    </div>
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Tabular review model
                        </label>
                        <ModelPreferenceDropdown
                            value={
                                profile?.tabularModel ??
                                "gemini-3-flash-preview"
                            }
                            apiKeys={{
                                claudeApiKey: profile?.claudeApiKey ?? null,
                                geminiApiKey: profile?.geminiApiKey ?? null,
                                openaiApiKey: profile?.openaiApiKey ?? null,
                                globalApiKeys: profile?.globalApiKeys,
                            }}
                            extraModels={aoaiModelEntries}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            </div>

            <div className="py-6">
                <p className="max-w-xl text-sm text-gray-500">
                    Provider credentials and Azure OpenAI connection settings
                    are shared by the organisation and managed by an
                    administrator through{" "}
                    <a
                        href={
                            (process.env.NEXT_PUBLIC_API_BASE_URL ??
                                "http://localhost:3001") + "/install"
                        }
                        className="font-medium text-gray-700 underline underline-offset-4"
                    >
                        organisation setup
                    </a>
                    . Users can choose from the models the administrator has
                    made available.
                </p>
                <DiscoveredDeployments
                    deployments={aoaiDeployments}
                    loading={aoaiDeploymentsLoading}
                    error={aoaiDeploymentsError}
                />
            </div>
        </div>
    );
}

function ModelPreferenceDropdown({
    value,
    onChange,
    apiKeys,
    extraModels,
    placeholder,
}: {
    // null means "no preference set" — backend resolver picks. The
    // dropdown shows the placeholder text and offers an explicit
    // "Auto" reset entry at the top.
    value: string | null;
    onChange: (id: string | null) => void;
    apiKeys: ApiKeyAvailability;
    extraModels: { id: string; label: string; group: "Azure OpenAI" }[];
    placeholder?: string;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const allModels = [...MODELS, ...extraModels];
    const selected = value ? allModels.find((m) => m.id === value) : null;
    const selectedAvailable = value
        ? isModelAvailable(value, apiKeys, extraModels)
        : true;
    const groups: (
        | "Anthropic"
        | "Google"
        | "OpenAI"
        | "Kimi"
        | "Azure OpenAI"
    )[] = [
        "Anthropic",
        "Google",
        "OpenAI",
        "Kimi",
        "Azure OpenAI",
    ];
    const showAutoOption = placeholder !== undefined;

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span
                            className={`truncate ${selected ? "text-gray-900" : "text-gray-500 italic"}`}
                        >
                            {selected?.label ??
                                placeholder ??
                                "Select a model"}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {showAutoOption && (
                    <>
                        <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => onChange(null)}
                            title="Let the backend pick the cheapest configured provider"
                        >
                            <span className="flex-1 italic text-gray-600">
                                {placeholder}
                            </span>
                            {!value && (
                                <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                            )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                )}
                {groups.map((group, gi) => {
                    const items = allModels.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const provider = modelGroupToProvider(m.group);
                                const available = isModelAvailable(
                                    m.id,
                                    apiKeys,
                                    extraModels,
                                );
                                const providerName = providerLabel(provider);
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={
                                            !available
                                                ? `Configure ${providerName} to use this model`
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
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function DiscoveredDeployments({
    deployments,
    loading,
    error,
}: {
    deployments: { name: string; model: string | null }[];
    loading: boolean;
    error: string | null;
}) {
    if (loading) {
        return (
            <p className="text-xs text-gray-500 mt-4 max-w-xl">
                Loading deployments…
            </p>
        );
    }
    if (error) {
        return (
            <p className="text-xs text-red-600 mt-4 max-w-xl">
                Could not list deployments: {error}
            </p>
        );
    }
    if (deployments.length === 0) {
        return (
            <p className="text-xs text-gray-500 mt-4 max-w-xl">
                No deployments are visible yet. Ask an administrator to check
                the Azure OpenAI settings in organisation setup or deploy a
                model in the configured Azure OpenAI resource.
            </p>
        );
    }
    return (
        <div className="mt-4 max-w-xl">
            <div className="text-xs text-gray-600 font-medium mb-2">
                Discovered deployments ({deployments.length})
            </div>
            <ul className="text-xs text-gray-500 space-y-1">
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
    );
}
