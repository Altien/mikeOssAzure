"use client";

import {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { currentAuthEpoch } from "@/app/lib/authEvents";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    type ApiKeyState,
    type ApiKeyProvider,
    type ApiKeySettings,
    type PersonalisationDetails,
    type PracticeSetting,
    type ProfessionalTitle,
    type UserProfile as ApiUserProfile,
    completeUserOnboarding,
    getUserProfile,
    isMfaRequiredError,
    MikeApiError,
    saveApiKey,
    setUserProfilePhoto,
    setApiKeyEnabled,
    updateUserMfaOnLogin,
    updateUserProfile,
    updateChatModel,
    updateChatReasoningLevel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
    parseTabularChatSelectionKey,
} from "@/app/lib/mikeApi";
import { apiKeyStateFromStatus } from "@/app/lib/apiKeyState";
import type { Message } from "@/app/components/shared/types";
import { applyDarkMode } from "@/app/lib/theme";
import { notifyError } from "@/app/lib/userFacingError";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import {
    ROUTER_PROFILE_FIELDS,
    routerProfileLists,
    type RouterProfileLists,
    type RouterSlug,
} from "@/shared/lib/modelCatalog";
import { publishTabularChatSettingsUpdate } from "@/app/lib/tabularChatSettingsEvents";
import {
    clearConfiguredModels,
    refreshConfiguredModels,
} from "@/app/hooks/useConfiguredModels";

interface UserProfile extends RouterProfileLists {
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
    subagentModel: string | null;
    subagentReasoning: NonNullable<Message["reasoning"]> | null;
    lastSelectedChatModel: string | null;
    lastSelectedReasoningLevel: NonNullable<Message["reasoning"]>;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    quickActionsVisible: boolean;
    darkMode: boolean;
    projectMemoryDefault: boolean;
    apiKeys: ApiKeyState;
    /** Settings saved with the user's own keys (region, endpoint, location, base URL). */
    apiKeySettings: ApiKeySettings;
}

export type PreferenceField =
    | "titleModel"
    | "tabularModel"
    | "memoryCuratorModel"
    | "subagentModel"
    | "subagentReasoning";

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
        field: PreferenceField,
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
    /** Save one router's Model Selections. */
    updateRouterModels: (
        router: RouterSlug,
        models: string[],
    ) => Promise<boolean>;
    updateDarkMode: (enabled: boolean) => Promise<void>;
    updateProjectMemoryDefault: (enabled: boolean) => Promise<void>;
    updateApiKey: (
        provider: ApiKeyProvider,
        value: string | null,
        settings?: ApiKeySettings[keyof ApiKeySettings],
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    updateApiKeyEnabled: (provider: ApiKeyProvider, enabled: boolean) => Promise<boolean>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

function emptyApiKeys(): ApiKeyState {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        mistral: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        vercel: { configured: false, source: null },
        "opencode-go": { configured: false, source: null },
        bedrock: { configured: false, source: null },
        azure: { configured: false, source: null },
        "azure-foundry": { configured: false, source: null },
        vertex: { configured: false, source: null },
        xai: { configured: false, source: null },
        custom: { configured: false, source: null },
        courtlistener: { configured: false, source: null },
        kimi: { configured: false, source: null },
        azure_openai: { configured: false, source: null },
        brave: { configured: false, source: null },
        tavily: { configured: false, source: null },
        deepseek: { configured: false, source: null },
    };
}

/** Normalizes the API profile into client defaults, including nullable photos and provider-key state. */
function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    const apiKeys = apiKeyStateFromStatus(apiKeyStatus);

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
        subagentModel: profile.subagentModel ?? null,
        subagentReasoning: profile.subagentReasoning ?? null,
        lastSelectedChatModel: profile.lastSelectedChatModel ?? null,
        lastSelectedReasoningLevel: profile.lastSelectedReasoningLevel ?? "high",
        mfaOnLogin: profile.mfaOnLogin === true,
        projectMemoryDefault: profile.projectMemoryDefault !== false,
        ...routerProfileLists(profile),
        apiKeys,
        apiKeySettings: apiKeyStatus.settings ?? {},
    };
}

/** Loads the authenticated profile and shares persisted updates across settings, navigation, and account consumers. */
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
        const globalEpoch = currentAuthEpoch();
        return () => identityRef.current === owner && authEpochRef.current === epoch && currentAuthEpoch() === globalEpoch;
    }, []);

    // Every mutator below keeps its `boolean` contract so callers need no
    // churn, but a failure is never silent any more: the context classifies
    // the error once and raises the notice that carries the sentence, an
    // honest "Retry" and the support link. That notice is the only report:
    // callers show no inline status for the same failure.
    //
    // The `if (!user) return false` guards stay silent on purpose: there is
    // no failed request to report, only a call made before there is a session.
    //
    // "Retry" re-enters the mutator through this ref rather than through the
    // closure that raised the notice, so it always re-runs the latest one
    // (the mutators are re-created whenever `user` changes).
    const retryRef = useRef<UserProfileContextType | null>(null);

    const failureEpoch = authEpochRef.current;
    const failureAuthEpoch = currentAuthEpoch();
    const reportFailure = useCallback(
        (error: unknown, action: string, retry: () => void) => {
            const isCurrent = () => identityRef.current === identity && authEpochRef.current === failureEpoch && currentAuthEpoch() === failureAuthEpoch;
            if (!isCurrent()) return;
            notifyError(error, {
                action,
                // One notice per setting, however many times an autosave loop
                // retries it.
                dedupeKey: `profile:${action}`,
                // Retry belongs to the account that failed, even though the implementation ref is latest.
                onRetry: () => { if (isCurrent()) retry(); },
            });
        },
        [identity, failureEpoch, failureAuthEpoch],
    );

    const loadProfile = useCallback(async () => {
        const owner = identity;
        const globalEpoch = currentAuthEpoch();
        const writeEpoch = writeEpochRef.current;
        const loadEpoch = ++loadEpochRef.current;
        const isCurrent = () => identityRef.current === owner && currentAuthEpoch() === globalEpoch &&
            writeEpochRef.current === writeEpoch && loadEpochRef.current === loadEpoch;
        try {
            let profileData: ApiUserProfile;
            try {
                profileData = await getUserProfile(isCurrent);
            } catch {
                // One retry with a short backoff absorbs a transient network
                // blip before the app falls back to the degraded profile.
                await new Promise((resolve) => setTimeout(resolve, 750));
                profileData = await getUserProfile(isCurrent);
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
            // The fallback profile below looks like a real, empty account, so
            // the load has to say that it failed rather than let the user read
            // placeholders as answers.
            notifyError(error, {
                action: "load your profile",
                dedupeKey: "profile-load",
                onRetry: () => {
                    if (isCurrent()) void retryRef.current?.reloadProfile();
                },
            });
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
                subagentModel: null,
                subagentReasoning: null,
                lastSelectedChatModel: null,
                lastSelectedReasoningLevel: "high",
                mfaOnLogin: false,
                legalResearchUs: true,
                quickActionsVisible: true,
                ...routerProfileLists({}),
                darkMode: false,
                projectMemoryDefault: true,
                apiKeys: emptyApiKeys(),
                apiKeySettings: {},
            });
        } finally {
            if (isCurrent()) setLoading(false);
        }
    }, [identity]);

    // A new signed-in user invalidates the shared model catalog. This runs as
    // a LAYOUT effect on purpose: React runs a component's passive effects
    // only after its descendants' passive effects, so the model pickers that
    // mount in the same commit (ChatInput, ModelToggle) used to start their
    // own request first and this provider then force-discarded it and sent
    // a second one: /models/configured twice on every signed-in page load.
    // Layout effects all run before any passive effect, so the provider's
    // refresh now starts first and the pickers join its in-flight request.
    useLayoutEffect(() => {
        if (isAuthenticated && userId) {
            void refreshConfiguredModels();
        } else {
            clearConfiguredModels();
        }
    }, [isAuthenticated, userId]);

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

    /** Persists a photo change before publishing the returned value to every profile consumer. */
    const updateProfilePhoto = useCallback(async (photo: string | null) => {
        if (!user) return;
        const current = accountGuard(user.id);
        if (!current()) return;
        const updated = await setUserProfilePhoto(photo, current);
        if (!current()) return;
        setProfile((previous) => previous ? { ...previous, profilePhoto: updated.profilePhoto } : previous);
    }, [user, accountGuard]);

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
            } catch (error) {
                reportFailure(error, "save your name", () => {
                    void retryRef.current?.updateDisplayName(displayName);
                });
                return false;
            }
        },
        [user, accountGuard, reportFailure],
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
                // An MFA challenge is a step in the flow, not a failure: the
                // caller opens the verification popup and re-runs the save.
                if (isMfaRequiredError(error)) throw error;
                reportFailure(error, "save your organisation", () => {
                    void retryRef.current?.updateOrganisation(organisation);
                });
                return false;
            }
        },
        [user, accountGuard, reportFailure],
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
            } catch (error) {
                reportFailure(error, "save your practice details", () => {
                    void retryRef.current?.completeOnboarding(details);
                });
                return false;
            }
        },
        [user, accountGuard, reportFailure],
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
            } catch (error) {
                reportFailure(
                    error,
                    "save your personalisation settings",
                    () => {
                        void retryRef.current?.updatePersonalisation(details);
                    },
                );
                return false;
            }
        },
        [reportFailure, user],
    );

    const syncPasswordSet = useCallback(async (): Promise<boolean> => {
        if (!user) return false;
        try {
            const updated = await getUserProfile(isCurrent);
            setProfile(toProfile(updated));
            return true;
        } catch (error) {
            reportFailure(error, "refresh your password status", () => {
                void retryRef.current?.syncPasswordSet();
            });
            return false;
        }
    }, [reportFailure, user]);

    const updateModelPreference = useCallback(
        async (
            field: PreferenceField,
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
            } catch (error) {
                reportFailure(error, "save your model preference", () => {
                    void retryRef.current?.updateModelPreference(field, value);
                });
                return false;
            }
        },
        [reportFailure, user],
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
            } catch (error) {
                reportFailure(error, "save your model selection", () => {
                    void retryRef.current?.persistChatModelSelection(
                        model,
                        chatId,
                    );
                });
                return false;
            }
        },
        [reportFailure, user],
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
            } catch (error) {
                reportFailure(error, "save your reasoning level", () => {
                    void retryRef.current?.persistChatReasoningSelection(
                        reasoningLevel,
                        chatId,
                    );
                });
                return false;
            }
        },
        [reportFailure, user],
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
                // An MFA challenge is a step in the flow, not a failure.
                if (isMfaRequiredError(error)) throw error;
                reportFailure(
                    error,
                    "update your login verification setting",
                    () => {
                        void retryRef.current?.updateMfaOnLogin(enabled);
                    },
                );
                return false;
            }
        },
        [reportFailure, user],
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
            } catch (error) {
                reportFailure(
                    error,
                    "update your case law research setting",
                    () => {
                        void retryRef.current?.updateLegalResearchUs(enabled);
                    },
                );
                return false;
            }
        },
        [reportFailure, user],
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
            } catch (error) {
                reportFailure(error, "update your quick actions setting", () => {
                    void retryRef.current?.updateQuickActionsVisible(visible);
                });
                return false;
            }
        },
        [reportFailure, user],
    );

    const updateRouterModels = useCallback(
        async (router: RouterSlug, models: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const current = accountGuard(user.id);
                if (!current()) return false;
                const updated = await updateUserProfile({
                    [ROUTER_PROFILE_FIELDS[router]]: models,
                }, current);
                if (!current()) return false;
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                reportFailure(error, `save your ${router} models`, () => {
                    void retryRef.current?.updateRouterModels(router, models);
                });
                return false;
            }
        },
        [user, accountGuard, reportFailure],
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
            settings?: ApiKeySettings[keyof ApiKeySettings],
        ): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                const status = await saveApiKey(provider, normalized, settings);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              apiKeys: {
                                  ...prev.apiKeys,
                                  [provider]: {
                                      configured: status[provider],
                                      enabled: status.enabled?.[provider] !== false,
                                      source:
                                          status.sources?.[provider] ?? null,
                                  },
                              },
                              apiKeySettings: status.settings ?? {},
                          }
                        : null,
                );
                void refreshConfiguredModels();
                return true;
            } catch (error) {
                // An MFA challenge is a step in the flow, not a failure.
                if (isMfaRequiredError(error)) throw error;
                if (error instanceof MikeApiError && error.status === 400) throw error;
                return false;
            }
        },
        [user],
    );

    const updateApiKeyEnabled = useCallback(
        async (provider: ApiKeyProvider, enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const current = accountGuard(user.id);
                if (!current()) return false;
                const status = await setApiKeyEnabled(provider, enabled, current);
                if (!current()) return false;
                setProfile((prev) => prev && current() ? {
                    ...prev,
                    apiKeys: Object.fromEntries(API_KEY_PROVIDERS.map((slug) => [slug, {
                        configured: !!status[slug],
                        source: status.sources?.[slug] ?? null,
                        enabled: status.enabled?.[slug] !== false,
                    }])) as ApiKeyState,
                } : prev);
                void refreshConfiguredModels();
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user, accountGuard],
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

    // A fresh object here re-renders every consumer of this context on every
    // provider render, profile change or not.
    const value = useMemo<UserProfileContextType>(
        () => ({
            profile,
            loading,
            apiKeysDegraded,
            updateProfilePhoto,
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
            updateRouterModels,
            updateDarkMode,
            updateProjectMemoryDefault,
            updateApiKey,
            updateApiKeyEnabled,
            reloadProfile,
            incrementMessageCredits,
        }),
        [
            profile,
            loading,
            apiKeysDegraded,
            updateProfilePhoto,
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
            updateRouterModels,
            updateDarkMode,
            updateProjectMemoryDefault,
            updateApiKey,
            updateApiKeyEnabled,
            reloadProfile,
            incrementMessageCredits,
        ],
    );

    // Keep the "Retry" entry point pointing at the current mutators.
    useAssignLatest(retryRef, value);

    return (
        <UserProfileContext.Provider value={value}>
            {children}
        </UserProfileContext.Provider>
    );
}

export function useOptionalUserProfile() {
    return useContext(UserProfileContext);
}

export function useUserProfile() {
    const context = useOptionalUserProfile();
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
