"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { RouterSettingsSection } from "@/app/components/settings/RouterSettingsSection";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { refreshOllamaModels } from "@/app/hooks/useOllamaModels";
import { refreshOpenCodeGoModels } from "@/app/hooks/useOpenCodeGoModels";
import { SettingsSection } from "../SettingsSection";

const MODEL_API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "kimi",
        label: "Moonshot (Kimi) API Key",
        placeholder: "sk-...",
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
        description:
            "After saving, pick the OpenRouter models you want offered in the composer below.",
    },
    {
        provider: "vercel",
        label: "Vercel AI Gateway API Key",
        placeholder: "vck_...",
        description:
            "After saving, pick the Vercel AI Gateway models you want offered in the composer below.",
    },
    {
        provider: "opencode-go",
        label: "OpenCode Go API Key",
        placeholder: "API key...",
        description:
            "OpenCode Go is a low-cost subscription for open coding models. After saving, choose any available OpenCode Go model from the searchable model picker.",
    },
    {
        provider: "opencode-go",
        label: "OpenCode Go API Key",
        placeholder: "sk-...",
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
    const { profile, updateApiKey, reloadProfile } = useUserProfile();
    const [refreshing, setRefreshing] = useState(false);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await Promise.all([
                reloadProfile(),
                refreshOllamaModels(),
                refreshOpenCodeGoModels(),
            ]);
        } finally {
            setRefreshing(false);
        }
    };

    return (
        <div>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    API Keys
                </h2>
                <p className="text-sm text-gray-500">
                    A personal API key saved here means all future requests for
                    the relevant provider will automatically be routed through
                    your API key and charged to your own API platform account.
                </p>
                <SettingsSection>
                    {MODEL_API_KEY_FIELDS.map((field) => (
                        <div key={field.provider}>
                            <ApiKeyField
                                label={field.label}
                                placeholder={field.placeholder}
                                hasSavedKey={
                                    profile?.apiKeys[field.provider].source ===
                                    "user"
                                }
                                onSave={(value) =>
                                    updateApiKey(
                                        field.provider,
                                        value.trim() || null,
                                    )
                                }
                                onRemove={() =>
                                    updateApiKey(field.provider, null)
                                }
                            />
                        </div>
                    ))}
                </SettingsSection>
            </div>
        </div>
    );
}
