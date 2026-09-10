"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
    useRef,
} from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    type ApiKeyState,
    type ApiKeyProvider,
    type PersonalisationDetails,
    type PracticeSetting,
    type ProfessionalTitle,
    type UserProfile as ApiUserProfile,
    completeUserOnboarding,
    getUserProfile,
    isMfaRequiredError,
    saveApiKey,
    updateUserMfaOnLogin,
    updateUserProfile,
    updateChatModel,
    updateChatReasoningLevel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
    parseTabularChatSelectionKey,
} from "@/app/lib/mikeApi";
import type { Message } from "@/app/components/shared/types";
import { applyDarkMode } from "@/app/lib/theme";
import { publishTabularChatSettingsUpdate } from "@/app/lib/tabularChatSettingsEvents";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    jurisdiction: string | null;
    practiceSetting: PracticeSetting | null;
    professionalTitle: ProfessionalTitle | null;
    practiceAreas: string[];
    onboardingVersion: number | null;
    onboardingComplete: boolean;
    passwordSet: boolean | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string | null;
    tabularModel: string | null;
    memoryCuratorModel: string | null;
    lastSelectedChatModel: string | null;
    lastSelectedReasoningLevel: NonNullable<Message["reasoning"]>;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    quickActionsVisible: boolean;
    openRouterModels: string[];
    vercelModels: string[];
    openCodeGoModels: string[];
    darkMode: boolean;
    projectMemoryDefault: boolean;
    apiKeys: ApiKeyState;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    /**
     * True when the profile fetch failed (after a retry) and `profile` holds
     * the local fallback. Every field on it is a placeholder, not an answer:
     * apiKeys say "nothing configured" and the router model lists are empty
     * only because the truth is unknown. Consumers must distinguish this from
     * a real profile that loaded with the same values — key-gated UI fails
     * open, and destructive normalization (e.g. resetting a saved composer
     * selection that is absent from the router lists) must not run at all.
     */
    apiKeysDegraded: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    completeOnboarding: (details?: PersonalisationDetails) => Promise<boolean>;
    updatePersonalisation: (
        details: PersonalisationDetails,
    ) => Promise<boolean>;
    syncPasswordSet: () => Promise<boolean>;
    updateModelPreference: (
        field: "titleModel" | "tabularModel" | "memoryCuratorModel",
        value: string | null,
    ) => Promise<boolean>;
    persistChatModelSelection: (
        model: string,
        chatId?: string | null,
    ) => Promise<boolean>;
    persistChatReasoningSelection: (
        reasoningLevel: NonNullable<Message["reasoning"]>,
        chatId?: string | null,
    ) => Promise<boolean>;
    updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
    updateLegalResearchUs: (enabled: boolean) => Promise<boolean>;
    updateQuickActionsVisible: (visible: boolean) => Promise<boolean>;
    updateOpenRouterModels: (models: string[]) => Promise<boolean>;
    updateVercelModels: (models: string[]) => Promise<boolean>;
    updateOpenCodeGoModels: (models: string[]) => Promise<boolean>;
    updateDarkMode: (enabled: boolean) => Promise<void>;
    updateProjectMemoryDefault: (enabled: boolean) => Promise<void>;
    updateApiKey: (
        provider: ApiKeyProvider,
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "vercel",
    "opencode-go",
    "courtlistener",
    // Upstream divergence (OSS-6, §2.3 item 3): dev's organisation
    // credentials (Key Vault) for Kimi and Azure OpenAI. The Azure OpenAI
    // deployment list lives in src/altien/models/aoaiDeployments.
    "kimi",
    "azure_openai",
];

function emptyApiKeys(): ApiKeyState {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        vercel: { configured: false, source: null },
        "opencode-go": { configured: false, source: null },
        courtlistener: { configured: false, source: null },
        kimi: { configured: false, source: null },
        azure_openai: { configured: false, source: null },
    };
}

function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    const apiKeys = emptyApiKeys();
    for (const provider of API_KEY_PROVIDERS) {
        apiKeys[provider] = {
            configured: !!apiKeyStatus[provider],
            source:
                apiKeyStatus.sources?.[provider] ??
                (apiKeyStatus[provider] ? "user" : null),
        };
    }

    return {
        ...profile,
        jurisdiction: profile.jurisdiction ?? null,
        practiceSetting: profile.practiceSetting ?? null,
        professionalTitle: profile.professionalTitle ?? null,
        practiceAreas: Array.isArray(profile.practiceAreas)
            ? profile.practiceAreas
            : [],
        onboardingVersion: profile.onboardingVersion ?? null,
        onboardingComplete: profile.onboardingComplete !== false,
        passwordSet: profile.passwordSet === true ? true : null,
        darkMode: profile.darkMode === true,
        memoryCuratorModel: profile.memoryCuratorModel ?? null,
        lastSelectedChatModel: profile.lastSelectedChatModel ?? null,
        lastSelectedReasoningLevel: profile.lastSelectedReasoningLevel ?? "high",
        mfaOnLogin: profile.mfaOnLogin === true,
        projectMemoryDefault: profile.projectMemoryDefault !== false,
        openRouterModels: Array.isArray(profile.openRouterModels)
            ? profile.openRouterModels
            : [],
        vercelModels: Array.isArray(profile.vercelModels)
            ? profile.vercelModels
            : [],
        openCodeGoModels: Array.isArray(profile.openCodeGoModels)
            ? profile.openCodeGoModels
            : [],
        apiKeys,
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [apiKeysDegraded, setApiKeysDegraded] = useState(false);
    const userId = user?.id ?? null;
    const identity = isAuthenticated ? userId : null;
    const identityRef = useRef(identity);
    const authEpochRef = useRef(0);
    const writeEpochRef = useRef(0);
    const loadEpochRef = useRef(0);
    const darkModeRequestRef = useRef(0);
    if (identityRef.current !== identity) {
        identityRef.current = identity;
        authEpochRef.current++;
        writeEpochRef.current++;
        loadEpochRef.current++;
        darkModeRequestRef.current++;
    }
    const accountGuard = useCallback((owner: string) => {
        const epoch = authEpochRef.current;
        return () => identityRef.current === owner && authEpochRef.current === epoch;
    }, []);

    const loadProfile = useCallback(async () => {
        const owner = identity;
        const writeEpoch = writeEpochRef.current;
        const loadEpoch = ++loadEpochRef.current;
        const isCurrent = () => identityRef.current === owner &&
            writeEpochRef.current === writeEpoch && loadEpochRef.current === loadEpoch;
        try {
            let profileData: ApiUserProfile;
            try {
                profileData = await getUserProfile();
            } catch {
                // One retry with a short backoff absorbs a transient network
                // blip before the app falls back to the degraded profile.
                await new Promise((resolve) => setTimeout(resolve, 750));
                profileData = await getUserProfile();
            }
            if (isCurrent()) {
                setProfile(toProfile(profileData));
                setApiKeysDegraded(false);
            }
        } catch (error) {
            if (!isCurrent()) return;
            console.warn(
                "[profile] fetch failed after retry; API key availability is unknown and fails open",
                error,
            );
            setApiKeysDegraded(true);
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                jurisdiction: null,
                practiceSetting: null,
                professionalTitle: null,
                practiceAreas: [],
                onboardingVersion: 0,
                onboardingComplete: true,
                passwordSet: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                titleModel: null,
                tabularModel: null,
                memoryCuratorModel: null,
                lastSelectedChatModel: null,
                lastSelectedReasoningLevel: "high",
                mfaOnLogin: false,
                legalResearchUs: true,
                quickActionsVisible: true,
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: [],
                darkMode: false,
                projectMemoryDefault: true,
                apiKeys: emptyApiKeys(),
            });
        } finally {
            if (isCurrent()) setLoading(false);
        }
    }, [identity]);

    useEffect(() => {
        if (isAuthenticated && userId) {
            setLoading(true);
            void loadProfile();
        } else {
            setProfile(null);
            setApiKeysDegraded(false);
            setLoading(false);
        }
    }, [isAuthenticated, userId, loadProfile]);

    useEffect(() => {
        applyDarkMode(profile?.darkMode === true);
    }, [profile?.darkMode]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) return false;
            const current = accountGuard(user.id);
            if (!current()) return false;

            try {
                const updated = await updateUserProfile({ displayName }, current);
                if (!current()) return false;
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, accountGuard],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            const current = accountGuard(user.id);
            if (!current()) return false;
            try {
                const updated = await updateUserProfile({ organisation }, current);
                if (!current()) return false;
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user, accountGuard],
    );

    const completeOnboarding = useCallback(
        async (details: PersonalisationDetails = {}): Promise<boolean> => {
            if (!user) return false;
            const current = accountGuard(user.id);
            if (!current()) return false;
            try {
                const updated = await completeUserOnboarding(details, current);
                if (!current()) return false;
                setProfile(toProfile(updated));
                return true;
            } catch {
                return false;
            }
        },
        [user, accountGuard],
    );

    const updatePersonalisation = useCallback(
        async (details: PersonalisationDetails): Promise<boolean> => {
            if (!user) return false;
            const owner = user.id;
            if (identityRef.current !== owner) return false;
            const epoch = ++writeEpochRef.current;
            loadEpochRef.current++;
            try {
                const updated = await updateUserProfile(details, () =>
                    identityRef.current === owner && writeEpochRef.current === epoch,
                );
                if (identityRef.current !== owner || writeEpochRef.current !== epoch) return false;
                loadEpochRef.current++;
                setProfile(toProfile(updated));
                setLoading(false);
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const syncPasswordSet = useCallback(async (): Promise<boolean> => {
        if (!user) return false;
        try {
            const updated = await getUserProfile();
            setProfile(toProfile(updated));
            return true;
        } catch {
            return false;
        }
    }, [user]);

    const updateModelPreference = useCallback(
        async (
            field: "titleModel" | "tabularModel" | "memoryCuratorModel",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    [field]: value,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const persistChatModelSelection = useCallback(
        async (model: string, chatId?: string | null): Promise<boolean> => {
            if (!user) return false;
            try {
                if (chatId) {
                    const tabularChat = parseTabularChatSelectionKey(chatId);
                    if (tabularChat) {
                        await updateTabularChatModel(
                            tabularChat.reviewId,
                            tabularChat.chatId,
                            model,
                        );
                        publishTabularChatSettingsUpdate({
                            reviewId: tabularChat.reviewId,
                            chatId: tabularChat.chatId,
                            model,
                        });
                    } else {
                        await updateChatModel(chatId, model);
                    }
                } else {
                    await updateLastSelectedChatSettings({
                        lastSelectedChatModel: model,
                    });
                }
                setProfile((current) =>
                    current
                        ? { ...current, lastSelectedChatModel: model }
                        : current,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const persistChatReasoningSelection = useCallback(
        async (
            reasoningLevel: NonNullable<Message["reasoning"]>,
            chatId?: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                if (chatId) {
                    const tabularChat = parseTabularChatSelectionKey(chatId);
                    if (tabularChat) {
                        await updateTabularChatReasoningLevel(
                            tabularChat.reviewId,
                            tabularChat.chatId,
                            reasoningLevel,
                        );
                        publishTabularChatSettingsUpdate({
                            reviewId: tabularChat.reviewId,
                            chatId: tabularChat.chatId,
                            reasoningLevel,
                        });
                    } else {
                        await updateChatReasoningLevel(chatId, reasoningLevel);
                    }
                } else {
                    await updateLastSelectedChatSettings({
                        lastSelectedReasoningLevel: reasoningLevel,
                    });
                }
                setProfile((current) =>
                    current
                        ? {
                              ...current,
                              lastSelectedReasoningLevel: reasoningLevel,
                          }
                        : current,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateMfaOnLogin = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserMfaOnLogin(enabled);
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateLegalResearchUs = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    legalResearchUs: enabled,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateQuickActionsVisible = useCallback(
        async (visible: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    quickActionsVisible: visible,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOpenRouterModels = useCallback(
        async (openRouterModels: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ openRouterModels });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateVercelModels = useCallback(
        async (vercelModels: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ vercelModels });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOpenCodeGoModels = useCallback(
        async (openCodeGoModels: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ openCodeGoModels });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateDarkMode = useCallback(
        async (enabled: boolean): Promise<void> => {
            if (!user) throw new Error("Sign in to update Dark Mode.");
            const current = accountGuard(user.id);
            if (!current()) throw new Error("Sign in to update Dark Mode.");
            const request = ++darkModeRequestRef.current;
            const previous = profile?.darkMode === true;
            setProfile((prev) => prev ? { ...prev, darkMode: enabled } : null);
            applyDarkMode(enabled);
            try {
                await updateUserProfile({ darkMode: enabled }, current);
                if (!current() || request !== darkModeRequestRef.current) return;
                setProfile((prev) => prev ? { ...prev, darkMode: enabled } : null);
            } catch (error) {
                if (!current() || request !== darkModeRequestRef.current) return;
                setProfile((prev) => prev ? { ...prev, darkMode: previous } : null);
                applyDarkMode(previous);
                throw error;
            }
        },
        [user, profile?.darkMode, accountGuard],
    );

    const updateProjectMemoryDefault = useCallback(
        async (enabled: boolean): Promise<void> => {
            if (!user) {
                throw new Error("Sign in to update memory settings.");
            }
            const updated = await updateUserProfile({
                projectMemoryDefault: enabled,
            });
            const normalized = toProfile(updated);
            setProfile((prev) =>
                prev
                    ? { ...prev, ...normalized, projectMemoryDefault: enabled }
                    : null,
            );
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: ApiKeyProvider,
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                const status = await saveApiKey(provider, normalized);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              apiKeys: {
                                  ...prev.apiKeys,
                                  [provider]: {
                                      configured: status[provider],
                                      source:
                                          status.sources?.[provider] ?? null,
                                  },
                              },
                          }
                        : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (userId) {
            await loadProfile();
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

        return false;
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                apiKeysDegraded,
                updateDisplayName,
                updateOrganisation,
                completeOnboarding,
                updatePersonalisation,
                syncPasswordSet,
                updateModelPreference,
                persistChatModelSelection,
                persistChatReasoningSelection,
                updateMfaOnLogin,
                updateLegalResearchUs,
                updateQuickActionsVisible,
                updateOpenRouterModels,
                updateVercelModels,
                updateOpenCodeGoModels,
                updateDarkMode,
                updateProjectMemoryDefault,
                updateApiKey,
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
