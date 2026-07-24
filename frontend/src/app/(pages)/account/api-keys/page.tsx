"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import {
    getApiKeyStatus,
    type ApiKeyProvider,
    type ApiKeyStatus,
} from "@/app/lib/mikeApi";

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
    {
        provider: "gemini",
        label: "Google Gemini",
        secret: "gemini-api-key",
    },
    {
        provider: "openai",
        label: "OpenAI",
        secret: "openai-api-key",
    },
    {
        provider: "kimi",
        label: "Kimi K3",
        secret: "moonshot-api-key",
    },
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
    const [status, setStatus] = useState<ApiKeyStatus | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    useEffect(() => {
        getApiKeyStatus()
            .then(setStatus)
            .catch(() => setLoadFailed(true));
    }, []);

    return (
        <div>
            <h2 className="mb-3 text-2xl font-medium font-serif text-gray-900">
                External services
            </h2>
            <p className="mb-4 max-w-2xl text-sm text-gray-500">
                Provider credentials are shared by everyone in this Mike
                installation. They are stored once in Azure Key Vault and can
                only be changed by an administrator through organisation
                setup.
            </p>

            {loadFailed && (
                <p className="mb-4 text-sm text-red-600">
                    Could not load organisation credential status.
                </p>
            )}

            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white divide-y divide-gray-200">
                {PROVIDERS.map((provider) => {
                    const configured = !!status?.[provider.provider];
                    return (
                        <div
                            key={provider.provider}
                            className="flex items-start justify-between gap-4 px-4 py-5"
                        >
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-800">
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
                                {status === null
                                    ? "Checking..."
                                    : configured
                                      ? "Configured for this organisation"
                                      : "Administrator action required"}
                            </div>
                        </div>
                    );
                })}
            </div>

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
