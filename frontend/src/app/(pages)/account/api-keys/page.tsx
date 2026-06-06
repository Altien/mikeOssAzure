"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";

const MODEL_API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-...",
    },
    {
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-...",
    },
] as const;

const OTHER_API_KEY_FIELDS = [
    {
        provider: "courtlistener",
        label: "CourtListener API Key",
        placeholder: "Token...",
        description:
            "Add a CourtListener API key if you want the latest CourtListener data. Otherwise, Mike will use the bulk data hosted by us.",
    },
] as const;

export default function ApiKeysPage() {
    const { profile, updateApiKey } = useUserProfile();

    return (
        <div>
            <h2 className="mb-3 text-2xl font-medium font-serif text-gray-900">
                API Keys
            </h2>
            <p className="text-sm text-gray-500 mb-4">
                You must provide your own API keys for the app to work or add
                your API keys into the .env file if you are running your own
                instance of Mike. All API keys are encrypted in storage.
            </p>
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white divide-y divide-gray-200">
                {MODEL_API_KEY_FIELDS.map((field) => (
                    <ApiKeyField
                        key={field.provider}
                        label={field.label}
                        placeholder={field.placeholder}
                        hasSavedKey={
                            !!profile?.apiKeys[field.provider].configured
                        }
                        isServerConfigured={
                            profile?.apiKeys[field.provider].source === "env"
                        }
                        onSave={(value) =>
                            updateApiKey(field.provider, value.trim() || null)
                        }
                        onRemove={() => updateApiKey(field.provider, null)}
                    />
                ))}
            </div>

            <div className="mt-8 overflow-hidden rounded-xl border border-gray-200 bg-white divide-y divide-gray-200">
                {OTHER_API_KEY_FIELDS.map((field) => (
                    <ApiKeyField
                        key={field.provider}
                        label={field.label}
                        description={field.description}
                        placeholder={field.placeholder}
                        hasSavedKey={
                            !!profile?.apiKeys[field.provider].configured
                        }
                        isServerConfigured={
                            profile?.apiKeys[field.provider].source === "env"
                        }
                        onSave={(value) =>
                            updateApiKey(field.provider, value.trim() || null)
                        }
                        onRemove={() => updateApiKey(field.provider, null)}
                    />
                ))}
            </div>
        </div>
    );
}

function ApiKeyField({
    label,
    description,
    placeholder,
    hasSavedKey,
    isServerConfigured,
    onSave,
    onRemove,
}: {
    label: string;
    description?: string;
    placeholder: string;
    hasSavedKey: boolean;
    isServerConfigured: boolean;
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
        <div className="px-4 py-5">
            <label className="text-sm font-medium text-gray-700 block mb-2">
                {label}
            </label>
            {description && (
                <p className="text-sm text-gray-500 mb-3">{description}</p>
            )}
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={
                            isServerConfigured
                                ? "Server .env key configured"
                                : hasSavedKey
                                  ? "Saved key hidden"
                                  : placeholder
                        }
                        className="bg-gray-50 pr-10 shadow-none disabled:text-gray-700 disabled:placeholder:text-gray-700"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isServerConfigured}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        disabled={isServerConfigured}
                        className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
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
                    variant="outline"
                    disabled={isServerConfigured || isSaving || !dirty || saved}
                    className="h-9 min-w-[74px] gap-1.5 bg-white px-2.5 text-xs text-gray-700 shadow-none hover:bg-gray-50"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-3.5 w-3.5" />
                            Saved
                        </>
                    ) : (
                        <>
                            <Save className="h-3.5 w-3.5" />
                            Save
                        </>
                    )}
                </Button>
                {hasSavedKey && !isServerConfigured && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleRemove}
                        disabled={isSaving}
                        className="h-9 gap-1.5 bg-white px-2.5 text-xs text-red-600 shadow-none hover:bg-red-50 hover:text-red-700"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                    </Button>
                )}
            </div>
        </div>
    );
}
