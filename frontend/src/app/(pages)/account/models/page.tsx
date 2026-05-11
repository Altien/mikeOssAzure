"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    type ApiKeyAvailability,
} from "@/app/lib/modelAvailability";

export default function ModelsAndApiKeysPage() {
    const {
        profile,
        updateModelPreference,
        updateApiKey,
        updateAzureOpenaiSettings,
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

            {/* API Keys */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        API Keys
                    </h2>
                </div>
                <ApiKeyHelpText globalApiKeys={profile?.globalApiKeys} />

                <p className="text-xs text-gray-400 mb-4 max-w-xl">
                    Title generation automatically routes to the cheapest model
                    of whichever provider you&rsquo;ve configured: Gemini Flash
                    Lite, then GPT-5 Nano, then Claude Haiku.
                </p>
                <div className="space-y-4 max-w-xl">
                    <ApiKeyField
                        label="Anthropic (Claude) API Key"
                        placeholder="sk-ant-…"
                        hasSavedKey={!!profile?.claudeApiKey}
                        onSave={(value) =>
                            updateApiKey("claude", value.trim() || null)
                        }
                        onRemove={() => updateApiKey("claude", null)}
                    />
                    <ApiKeyField
                        label="Google (Gemini) API Key"
                        placeholder="AI…"
                        hasSavedKey={!!profile?.geminiApiKey}
                        onSave={(value) =>
                            updateApiKey("gemini", value.trim() || null)
                        }
                        onRemove={() => updateApiKey("gemini", null)}
                    />
                    <ApiKeyField
                        label="OpenAI API Key"
                        placeholder="sk-…"
                        initialValue={profile?.openaiApiKey ?? ""}
                        onSave={(value) =>
                            updateApiKey("openai", value.trim() || null)
                        }
                    />
                </div>
            </div>

            {/* Azure OpenAI */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        Azure OpenAI
                    </h2>
                </div>
                <p className="text-sm text-gray-500 mb-4 max-w-xl">
                    Connect to a deployment in your own Azure subscription.
                    Endpoint and API key are required; deployments are
                    discovered from the endpoint and listed in the model
                    picker. The optional default deployment is used by
                    title generation when no other provider is configured.
                </p>
                <AzureOpenaiSettingsForm
                    settings={
                        profile?.azureOpenai ?? {
                            endpoint: null,
                            apiKey: null,
                            apiVersion: null,
                            deployment: null,
                        }
                    }
                    onSave={updateAzureOpenaiSettings}
                />
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
    const groups: ("Anthropic" | "Google" | "OpenAI" | "Azure OpenAI")[] = [
        "Anthropic",
        "Google",
        "OpenAI",
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
                                const providerName =
                                    provider === "claude"
                                        ? "Claude"
                                        : provider === "gemini"
                                          ? "Gemini"
                                          : provider === "openai"
                                            ? "OpenAI"
                                            : "Azure OpenAI";
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

type GlobalKeysShape = {
    claude: boolean;
    gemini: boolean;
    openai: boolean;
    azureOpenai: boolean;
};

function ApiKeyHelpText({
    globalApiKeys,
}: {
    globalApiKeys: GlobalKeysShape | undefined;
}) {
    const labels: Record<keyof GlobalKeysShape, string> = {
        claude: "Anthropic",
        gemini: "Google",
        openai: "OpenAI",
        azureOpenai: "Azure OpenAI",
    };
    const configured = globalApiKeys
        ? (Object.keys(labels) as Array<keyof GlobalKeysShape>)
              .filter((k) => globalApiKeys[k])
              .map((k) => labels[k])
        : [];
    const message =
        configured.length === 0
            ? "No shared key is configured on this server. Paste your own API key for at least one provider to use the app."
            : configured.length === 4
              ? "A shared key is configured for all providers, so the app works out of the box. Paste a personal key here to use your own quota instead."
              : `A shared key is configured for ${configured.join(", ")}. Paste a personal key for any other provider, or override a shared one.`;
    return (
        <p className="text-sm text-gray-500 mb-4 max-w-xl">{message}</p>
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
                No deployments visible yet. Save endpoint + API key above,
                or deploy a model in your Azure OpenAI resource.
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

function AzureOpenaiSettingsForm({
    settings,
    onSave,
}: {
    settings: {
        endpoint: string | null;
        apiKey: string | null;
        apiVersion: string | null;
        deployment: string | null;
    };
    onSave: (patch: {
        endpoint?: string | null;
        apiKey?: string | null;
        apiVersion?: string | null;
        deployment?: string | null;
    }) => Promise<boolean>;
}) {
    const [endpoint, setEndpoint] = useState(settings.endpoint ?? "");
    const [apiKey, setApiKey] = useState(settings.apiKey ?? "");
    const [apiVersion, setApiVersion] = useState(settings.apiVersion ?? "");
    const [deployment, setDeployment] = useState(settings.deployment ?? "");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setEndpoint(settings.endpoint ?? "");
        setApiKey(settings.apiKey ?? "");
        setApiVersion(settings.apiVersion ?? "");
        setDeployment(settings.deployment ?? "");
    }, [
        settings.endpoint,
        settings.apiKey,
        settings.apiVersion,
        settings.deployment,
    ]);

    const dirty =
        endpoint !== (settings.endpoint ?? "") ||
        apiKey !== (settings.apiKey ?? "") ||
        apiVersion !== (settings.apiVersion ?? "") ||
        deployment !== (settings.deployment ?? "");

    const handleSave = async () => {
        setIsSaving(true);
        const ok = await onSave({ endpoint, apiKey, apiVersion, deployment });
        setIsSaving(false);
        if (ok) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert("Failed to save Azure OpenAI settings.");
        }
    };

    return (
        <div className="space-y-4 max-w-xl">
            <div>
                <label className="text-sm text-gray-600 block mb-2">
                    Endpoint
                </label>
                <Input
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://your-resource.openai.azure.com"
                    autoComplete="off"
                    spellCheck={false}
                />
            </div>
            <div>
                <label className="text-sm text-gray-600 block mb-2">
                    API Key
                </label>
                <div className="relative">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="Azure OpenAI key"
                        className="pr-10"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
                        aria-label={reveal ? "Hide key" : "Show key"}
                    >
                        {reveal ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                </div>
            </div>
            <div>
                <label className="text-sm text-gray-600 block mb-2">
                    Deployment name
                </label>
                <Input
                    value={deployment}
                    onChange={(e) => setDeployment(e.target.value)}
                    placeholder="e.g. gpt-5"
                    autoComplete="off"
                    spellCheck={false}
                />
            </div>
            <div>
                <label className="text-sm text-gray-600 block mb-2">
                    API version{" "}
                    <span className="text-gray-400">
                        (optional — defaults to a recent stable version)
                    </span>
                </label>
                <Input
                    value={apiVersion}
                    onChange={(e) => setApiVersion(e.target.value)}
                    placeholder="2024-10-21"
                    autoComplete="off"
                    spellCheck={false}
                />
            </div>
            <div className="flex justify-end">
                <Button
                    onClick={handleSave}
                    disabled={isSaving || !dirty || saved}
                    className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-4 w-3" />
                            Saved
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
            </div>
        </div>
    );
}

function ApiKeyField({
    label,
    placeholder,
    hasSavedKey,
    onSave,
    onRemove,
}: {
    label: string;
    placeholder: string;
    hasSavedKey: boolean;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setValue("");
    }, [hasSavedKey]);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        const ok = await onSave(value);
        setIsSaving(false);
        if (ok) {
            setValue("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(`Failed to save ${label}.`);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        const ok = await onRemove();
        setIsSaving(false);
        if (!ok) alert(`Failed to remove ${label}.`);
    };

    return (
        <div>
            <label className="text-sm text-gray-600 block mb-2">{label}</label>
            {hasSavedKey && (
                <p className="text-xs text-gray-500 mb-2">
                    A key is saved. Paste a new key to replace it.
                </p>
            )}
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={hasSavedKey ? "Saved key hidden" : placeholder}
                        className="pr-10"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
                        aria-label={reveal ? "Hide key" : "Show key"}
                    >
                        {reveal ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                </div>
                <Button
                    onClick={handleSave}
                    disabled={isSaving || !dirty || saved}
                    className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-4 w-3" />
                            Saved
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
                {hasSavedKey && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleRemove}
                        disabled={isSaving}
                    >
                        Remove
                    </Button>
                )}
            </div>
        </div>
    );
}
