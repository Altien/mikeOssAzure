"use client";

import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ApiKeyProvider } from "@/app/lib/mikeApi";
// Upstream divergence (OSS-6, §2.3 item 3 — org Key Vault keys): upstream's
// page lets each user paste personal provider keys (ApiKeyField + PUT
// /user/api-keys/:provider). Dev's credentials are organisation secrets in
// Azure Key Vault, set by an administrator through /install; the backend
// rejects personal keys (PUT returns an "organisation credential required"
// error). So this page is a read-only status list in upstream's layout
// (header, SettingsSection), including dev's Kimi and Azure OpenAI. Upstream
// dropped the page's Refresh button in 93c72a16 (it only re-detected local
// Ollama models, which dev does not serve).
// Upstream divergence (sync-log: 3a10943): upstream gates key save/remove
// behind MfaVerificationPopup. Dev has no app-level MFA and no key editing.
import { SettingsSection } from "../SettingsSection";

const PROVIDERS: ReadonlyArray<{
    provider: ApiKeyProvider;
    label: string;
    secret: string;
}> = [
    {
        provider: "claude",
        label: "Anthropic (Claude)",
        secret: "anthropic-api-key",
    },
    { provider: "gemini", label: "Google (Gemini)", secret: "gemini-api-key" },
    { provider: "openai", label: "OpenAI", secret: "openai-api-key" },
    { provider: "kimi", label: "Kimi K3", secret: "moonshot-api-key" },
    {
        provider: "openrouter",
        label: "OpenRouter",
        secret: "openrouter-api-key",
    },
    {
        provider: "courtlistener",
        label: "CourtListener",
        secret: "courtlistener-api-token",
    },
    {
        provider: "azure_openai",
        label: "Azure OpenAI",
        secret: "azure-openai-endpoint + azure-openai-api-key",
    },
];

const INSTALL_URL =
    (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") +
    "/install";

export default function ApiKeysPage() {
    const { profile } = useUserProfile();

    return (
        <div>
            <div className="mb-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    API Keys
                </h2>
            </div>
            <p className="text-sm text-gray-500 mb-4">
                Provider credentials are shared by everyone in this Mike
                installation. They are stored once in Azure Key Vault and can
                only be changed by an administrator through organisation
                setup.
            </p>
            <SettingsSection>
                {PROVIDERS.map((provider, index) => {
                    const configured =
                        !!profile?.apiKeys[provider.provider]?.configured;
                    return (
                        <div key={provider.provider}>
                            <div className="flex items-start justify-between gap-4 px-4 py-5">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-gray-700">
                                        {provider.label}
                                    </p>
                                    <p className="mt-1 text-xs text-gray-500">
                                        Key Vault: {provider.secret}
                                    </p>
                                </div>
                                <div
                                    className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${
                                        configured
                                            ? "text-emerald-700"
                                            : "text-amber-700"
                                    }`}
                                >
                                    {configured ? (
                                        <CheckCircle2 className="h-4 w-4" />
                                    ) : (
                                        <AlertTriangle className="h-4 w-4" />
                                    )}
                                    {profile === null
                                        ? "Checking..."
                                        : configured
                                          ? "Configured for this organisation"
                                          : "Administrator action required"}
                                </div>
                            </div>
                            {index < PROVIDERS.length - 1 && (
                                <div className="mx-4 h-px bg-gray-200" />
                            )}
                        </div>
                    );
                })}
            </SettingsSection>
            <a
                href={INSTALL_URL}
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 underline underline-offset-4 hover:text-gray-950"
            >
                Open organisation setup
                <ExternalLink className="h-3.5 w-3.5" />
            </a>
        </div>
    );
}
