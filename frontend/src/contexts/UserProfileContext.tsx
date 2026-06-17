"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import { bounceIfUnauthorized } from "@/lib/auth-token";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string;
    tabularModel: string;
    fastModel: string | null;
    // Features > Legal Research > Jurisdiction > US toggle (upstream
    // 1fa0554). Defaults to enabled.
    legalResearchUs: boolean;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey: string | null;
    // Azure OpenAI is multi-field (endpoint + key + apiVersion + deployment)
    // because the SDK needs all of those to reach a customer's deployment.
    azureOpenai: {
        endpoint: string | null;
        apiKey: string | null;
        apiVersion: string | null;
        deployment: string | null;
    };
    // Whether the backend has a shared (env-level) key for each provider.
    // Lets the model dropdown / settings page show the provider as
    // available even when the user hasn't pasted a personal key.
    globalApiKeys: {
        claude: boolean;
        gemini: boolean;
        openai: boolean;
        azureOpenai: boolean;
    };
}

export type AzureOpenaiSettingsPatch = {
    endpoint?: string | null;
    apiKey?: string | null;
    apiVersion?: string | null;
    deployment?: string | null;
};

// One row in the model dropdown for an AOAI deployment discovered
// against the configured endpoint. Surfaced through context so all
// dropdowns share the same in-session cache and the network call only
// happens once per profile load.
export type AoaiDeployment = {
    name: string;
    model: string | null;
};

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    aoaiDeployments: AoaiDeployment[];
    aoaiDeploymentsLoading: boolean;
    aoaiDeploymentsError: string | null;
    reloadAoaiDeployments: () => Promise<void>;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel" | "fastModel",
        value: string | null,
    ) => Promise<boolean>;
    updateLegalResearchUs: (enabled: boolean) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini" | "openai",
        value: string | null,
    ) => Promise<boolean>;
    updateAzureOpenaiSettings: (
        patch: AzureOpenaiSettingsPatch,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated, getAccessToken } = useAuth();
    const userId = user?.id ?? null;
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [aoaiDeployments, setAoaiDeployments] = useState<AoaiDeployment[]>(
        [],
    );
    const [aoaiDeploymentsLoading, setAoaiDeploymentsLoading] =
        useState(false);
    const [aoaiDeploymentsError, setAoaiDeploymentsError] = useState<
        string | null
    >(null);

    const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") + "/api";

    const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
        const token = await getAccessToken();
        const response = await fetch(`${apiBase}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(init?.headers ?? {}),
            },
        });
        // Mirror the 401 handling in mikeApi.ts so a stale token can't
        // trap the user in a half-authenticated state.
        bounceIfUnauthorized(response);
        if (!response.ok) throw new Error(await response.text());
        return response;
    }, [getAccessToken, apiBase]);

    const loadProfile = useCallback(async (_userId: string) => {
        try {
            const response = await authedFetch("/user/profile");
            const data = await response.json();
            const monthlyCreditLimit = 999999;
            const creditsUsed = data.message_credits_used ?? 0;
            setProfile({
                displayName: data.display_name ?? null,
                organisation: data.organisation ?? null,
                messageCreditsUsed: creditsUsed,
                creditsResetDate: data.credits_reset_date,
                creditsRemaining: monthlyCreditLimit - creditsUsed,
                tier: data.tier || "Free",
                titleModel: data.title_model || "gemini-3.1-flash-lite-preview",
                tabularModel: data.tabular_model || "gemini-3-flash-preview",
                fastModel: data.fast_model ?? null,
                legalResearchUs: data.legal_research_us !== false,
                claudeApiKey: data.claude_api_key ?? null,
                geminiApiKey: data.gemini_api_key ?? null,
                openaiApiKey: data.openai_api_key ?? null,
                azureOpenai: {
                    endpoint: data.azure_openai_endpoint ?? null,
                    apiKey: data.azure_openai_api_key ?? null,
                    apiVersion: data.azure_openai_api_version ?? null,
                    deployment: data.azure_openai_deployment ?? null,
                },
                globalApiKeys: {
                    claude: !!data.global_api_keys?.claude,
                    gemini: !!data.global_api_keys?.gemini,
                    openai: !!data.global_api_keys?.openai,
                    azureOpenai: !!data.global_api_keys?.azureOpenai,
                },
            });
        } catch {
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);
            setProfile({
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999,
                tier: "Free",
                titleModel: "gemini-3.1-flash-lite-preview",
                tabularModel: "gemini-3-flash-preview",
                fastModel: null,
                legalResearchUs: true,
                claudeApiKey: null,
                geminiApiKey: null,
                openaiApiKey: null,
                azureOpenai: {
                    endpoint: null,
                    apiKey: null,
                    apiVersion: null,
                    deployment: null,
                },
                globalApiKeys: {
                    claude: false,
                    gemini: false,
                    openai: false,
                    azureOpenai: false,
                },
            });
        } finally {
            setLoading(false);
        }
    }, [authedFetch]);

    // Auto-fetch on profile load. Cached for the session — the only
    // refetch trigger is reloadAoaiDeployments(), which the settings
    // page calls after the user saves AOAI credentials. We deliberately
    // don't poll: deployments rarely change and the AOAI API is paid.
    const loadAoaiDeployments = useCallback(async () => {
        setAoaiDeploymentsLoading(true);
        setAoaiDeploymentsError(null);
        try {
            const response = await authedFetch("/llm/azure-openai/deployments");
            const data = (await response.json()) as {
                source: "personal" | "global" | null;
                deployments: AoaiDeployment[];
            };
            setAoaiDeployments(data.deployments ?? []);
        } catch (err) {
            console.error("[aoai-deployments] context fetch failed", err);
            setAoaiDeployments([]);
            setAoaiDeploymentsError(
                err instanceof Error
                    ? err.message
                    : "Failed to list Azure OpenAI deployments",
            );
        } finally {
            setAoaiDeploymentsLoading(false);
        }
    }, [authedFetch]);

    // Depend on the stable userId (not the user object identity) so the
    // profile is not refetched on every auth-context object churn —
    // adopted from upstream 444d1d3.
    useEffect(() => {
        if (isAuthenticated && userId) {
            setLoading(true);
            loadProfile(userId);
            loadAoaiDeployments();
        } else {
            setProfile(null);
            setLoading(false);
            setAoaiDeployments([]);
            setAoaiDeploymentsError(null);
        }
    }, [isAuthenticated, userId, loadProfile, loadAoaiDeployments]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                await authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify({ display_name: displayName }),
                });

                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user, authedFetch],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify({ organisation }),
                });
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, authedFetch],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel" | "fastModel",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbColumn =
                field === "tabularModel" ? "tabular_model" : "fast_model";
            try {
                await authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify({ [dbColumn]: value }),
                });
                setProfile((prev) =>
                    prev ? { ...prev, [field]: value } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, authedFetch],
    );

    const updateLegalResearchUs = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                await authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify({ legal_research_us: enabled }),
                });
                setProfile((prev) =>
                    prev ? { ...prev, legalResearchUs: enabled } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, authedFetch],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini" | "openai",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const fieldMap = {
                claude: { state: "claudeApiKey", db: "claude_api_key" },
                gemini: { state: "geminiApiKey", db: "gemini_api_key" },
                openai: { state: "openaiApiKey", db: "openai_api_key" },
            } as const;
            const { state, db } = fieldMap[provider];
            const normalized = value?.trim() ? value.trim() : null;
            try {
                await authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify({ [db]: normalized }),
                });
                setProfile((prev) =>
                    prev ? { ...prev, [state]: normalized } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, authedFetch],
    );

    const updateAzureOpenaiSettings = useCallback(
        async (patch: AzureOpenaiSettingsPatch): Promise<boolean> => {
            if (!user) return false;
            // Map UI-shaped patch to DB column names. Treating empty
            // strings as nulls keeps the "clear this field" UX simple.
            const body: Record<string, string | null> = {};
            const norm = (v: string | null | undefined): string | null =>
                v?.trim() ? v.trim() : null;
            if ("endpoint" in patch)
                body.azure_openai_endpoint = norm(patch.endpoint);
            if ("apiKey" in patch)
                body.azure_openai_api_key = norm(patch.apiKey);
            if ("apiVersion" in patch)
                body.azure_openai_api_version = norm(patch.apiVersion);
            if ("deployment" in patch)
                body.azure_openai_deployment = norm(patch.deployment);
            if (Object.keys(body).length === 0) return true;
            try {
                await authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                setProfile((prev) => {
                    if (!prev) return null;
                    return {
                        ...prev,
                        azureOpenai: {
                            endpoint:
                                "endpoint" in patch
                                    ? norm(patch.endpoint)
                                    : prev.azureOpenai.endpoint,
                            apiKey:
                                "apiKey" in patch
                                    ? norm(patch.apiKey)
                                    : prev.azureOpenai.apiKey,
                            apiVersion:
                                "apiVersion" in patch
                                    ? norm(patch.apiVersion)
                                    : prev.azureOpenai.apiVersion,
                            deployment:
                                "deployment" in patch
                                    ? norm(patch.deployment)
                                    : prev.azureOpenai.deployment,
                        },
                    };
                });
                // Saving credentials may have changed which deployments
                // are visible — refresh the dropdown source.
                loadAoaiDeployments();
                return true;
            } catch {
                return false;
            }
        },
        [user, authedFetch, loadAoaiDeployments],
    );

    const reloadProfile = useCallback(async () => {
        if (userId) {
            await loadProfile(userId);
        }
    }, [userId, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        try {
            const response = await authedFetch("/user/profile/credits/increment", { method: "POST" });
            const payload = await response.json();
            const newCreditsUsed = payload.message_credits_used;

            // Update local state
            setProfile((prev) =>
                prev
                    ? {
                          ...prev,
                          messageCreditsUsed: newCreditsUsed,
                          creditsRemaining: 999999 - newCreditsUsed, // temporarily unlimited
                      }
                    : null,
            );

            return true;
        } catch {
            return false;
        }
    }, [user, profile, authedFetch]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                aoaiDeployments,
                aoaiDeploymentsLoading,
                aoaiDeploymentsError,
                reloadAoaiDeployments: loadAoaiDeployments,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateLegalResearchUs,
                updateApiKey,
                updateAzureOpenaiSettings,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
