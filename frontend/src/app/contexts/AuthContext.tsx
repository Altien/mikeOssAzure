"use client";

import {
    createContext,
    useContext,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    ReactNode,
} from "react";
import {
    clearLegacyBrowserAuthStorage,
    getAuthSession,
    loginLocal,
    logout,
    updateAuthEmail,
    updateAuthPassword,
    type AuthUser,
} from "@/app/lib/authApi";
import { AUTH_SESSION_INVALIDATED_EVENT, advanceAuthEpoch } from "@/app/lib/authEvents";
import { setReportingUser } from "@/app/lib/errorReporting";
import { isOnAuthRoute, notifyError } from "@/app/lib/userFacingError";
import { clearToasts } from "@/shared/ui/ToastUI";

type User = AuthUser;

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    authError: string | null;
    signOut: () => Promise<void>;
    signInLocal: (email: string) => Promise<void>;
    getAccessToken: () => Promise<string | null>;
    updateEmail: (email: string) => Promise<User>;
    setPassword: (password: string, nonce?: string) => Promise<void>;
    refreshSession: () => Promise<User | null>;
    retrySession: () => Promise<User | null>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);
const AUTH_SYNC_CHANNEL = "mike-auth-state";
const AUTH_SYNC_STORAGE_KEY = "mike-auth-state-change";
const SESSION_ERROR_MESSAGE =
    "We could not check your session. Please try again.";
const EXPIRED_SESSION_MESSAGE = "Your session expired. Please log in again.";

type AuthSyncMessage = {
    state: "signed-in" | "signed-out";
    nonce: string;
};

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [authError, setAuthError] = useState<string | null>(null);
    const channelRef = useRef<BroadcastChannel | null>(null);
    const authGeneration = useRef(0);
    const identityRef = useRef<string | null>(null);
    const sessionRequestRef = useRef<{ generation: number; promise: Promise<User | null> } | null>(null);

    // Upstream divergence (sync-log: c94052d7): retain Dev generation fences while
    // discarding retry closures whenever a session ends or its identity changes.
    const applySessionUser = useCallback((nextUser: User | null) => {
        if (!nextUser || identityRef.current !== nextUser.id) clearToasts();
        if (identityRef.current !== (nextUser?.id ?? null)) {
            identityRef.current = nextUser?.id ?? null;
            advanceAuthEpoch();
        }
        setUser(nextUser);
    }, []);

    const broadcastAuthState = useCallback(
        (state: AuthSyncMessage["state"]) => {
            const message: AuthSyncMessage = {
                state,
                nonce:
                    typeof crypto.randomUUID === "function"
                        ? crypto.randomUUID()
                        : `${Date.now()}-${Math.random()}`,
            };
            channelRef.current?.postMessage(message);
            try {
                window.localStorage.setItem(
                    AUTH_SYNC_STORAGE_KEY,
                    JSON.stringify(message),
                );
            } catch {
                // Cross-tab sync is best-effort when storage is unavailable.
            }
        },
        [],
    );

    // Error reports carry the user id (never the email) so an issue can say
    // how many people it affects; cleared again on sign-out.
    useEffect(() => {
        setReportingUser(user ? { id: user.id } : null);
    }, [user]);

    const fetchAndApplySession = useCallback(async () => {
        const generation = authGeneration.current;
        if (!sessionRequestRef.current || sessionRequestRef.current.generation !== generation) {
            const promise = getAuthSession().finally(() => {
                if (sessionRequestRef.current?.generation === generation) sessionRequestRef.current = null;
            });
            sessionRequestRef.current = { generation, promise };
        }
        let nextUser: User | null;
        try { nextUser = await sessionRequestRef.current.promise; }
        catch (error) { if (generation !== authGeneration.current) return null; throw error; }
        if (generation !== authGeneration.current) return null;
        applySessionUser(nextUser);
        setAuthError(null);
        return nextUser;
    }, [applySessionUser]);

    const checkBackgroundSession = useCallback(() => {
        const generation = authGeneration.current;
        const reportFailure = (error: unknown) => {
            if (generation !== authGeneration.current) return;
            setAuthError(SESSION_ERROR_MESSAGE);
            // Sign-in screens show `authError` themselves, with their own
            // Retry; a toast there repeated it and then contradicted the
            // form's next error.
            if (isOnAuthRoute()) return;
            notifyError(error, {
                action: "check your session", dedupeKey: "auth-session",
                onRetry: async () => {
                    if (generation !== authGeneration.current) return;
                    try { await fetchAndApplySession(); }
                    catch (retryError) { reportFailure(retryError); }
                },
            });
        };
        return fetchAndApplySession().catch(reportFailure);
    }, [fetchAndApplySession]);

    useEffect(() => {
        clearLegacyBrowserAuthStorage();

        const channel =
            typeof BroadcastChannel === "undefined"
                ? null
                : new BroadcastChannel(AUTH_SYNC_CHANNEL);
        channelRef.current = channel;

        const applySyncMessage = (message: AuthSyncMessage) => {
            if (message.state === "signed-out") {
                authGeneration.current += 1;
                identityRef.current = null;
                advanceAuthEpoch();
                applySessionUser(null);
                setAuthError(null);
                setAuthLoading(false);
                return;
            }

            authGeneration.current += 1;
            advanceAuthEpoch();
            void checkBackgroundSession();
        };

        const onChannelMessage = (event: MessageEvent<AuthSyncMessage>) => {
            if (
                event.data?.state === "signed-in" ||
                event.data?.state === "signed-out"
            ) {
                applySyncMessage(event.data);
            }
        };
        const onStorage = (event: StorageEvent) => {
            if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) return;
            try {
                const message = JSON.parse(event.newValue) as AuthSyncMessage;
                if (
                    message.state === "signed-in" ||
                    message.state === "signed-out"
                ) {
                    applySyncMessage(message);
                }
            } catch {
                // Ignore unrelated or malformed storage values.
            }
        };
        const onInvalidated = () => {
            authGeneration.current += 1;
            identityRef.current = null;
            advanceAuthEpoch();
            applySessionUser(null);
            setAuthError(EXPIRED_SESSION_MESSAGE);
            setAuthLoading(false);
            broadcastAuthState("signed-out");
        };
        const onVisibilityChange = () => {
            if (document.visibilityState !== "visible") return;
            void checkBackgroundSession();
        };
        const onFocus = () => {
            void checkBackgroundSession();
        };

        channel?.addEventListener("message", onChannelMessage);
        window.addEventListener("storage", onStorage);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, onInvalidated);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibilityChange);

        void checkBackgroundSession()
            .finally(() => setAuthLoading(false));

        return () => {
            channel?.removeEventListener("message", onChannelMessage);
            channel?.close();
            channelRef.current = null;
            window.removeEventListener("storage", onStorage);
            window.removeEventListener(
                AUTH_SESSION_INVALIDATED_EVENT,
                onInvalidated,
            );
            window.removeEventListener("focus", onFocus);
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
        };
    }, [applySessionUser, broadcastAuthState, checkBackgroundSession]);

    const refreshSession = useCallback(async () => {
        const generation = authGeneration.current;
        try {
            const nextUser = await fetchAndApplySession();
            if (generation !== authGeneration.current) return null;
            setAuthLoading(false);
            broadcastAuthState(nextUser ? "signed-in" : "signed-out");
            return nextUser;
        } catch (error) {
            if (generation === authGeneration.current) {
                setAuthError(SESSION_ERROR_MESSAGE);
                setAuthLoading(false);
            }
            throw error;
        }
    }, [broadcastAuthState, fetchAndApplySession]);

    const signOut = useCallback(async () => {
        clearToasts();
        const generation = ++authGeneration.current;
        identityRef.current = null;
        advanceAuthEpoch();
        try {
            const result = await logout("local");
            if (generation !== authGeneration.current) return;
            applySessionUser(null);
            setAuthError(null);
            broadcastAuthState("signed-out");
            if (result.logoutUrl) window.location.assign(result.logoutUrl);
        } catch (error) {
            if (generation === authGeneration.current)
                setAuthError("Unable to sign out. Please try again.");
            throw error;
        }
    }, [applySessionUser, broadcastAuthState]);

    const signInLocal = useCallback(async (email: string) => {
        clearToasts();
        const generation = ++authGeneration.current;
        advanceAuthEpoch();
        await loginLocal(email);
        if (generation !== authGeneration.current) return;
        await fetchAndApplySession();
        broadcastAuthState("signed-in");
    }, [broadcastAuthState, fetchAndApplySession]);

    const updateEmail = useCallback(async (email: string) => {
        const generation = authGeneration.current;
        const identity = identityRef.current;
        const { user: nextUser } = await updateAuthEmail(
            email,
            "/settings?emailChange=processed",
        );
        if (generation === authGeneration.current && identity === identityRef.current && nextUser.id === identity) applySessionUser(nextUser);
        return nextUser;
    }, [applySessionUser]);

    const setPassword = useCallback(async (password: string, nonce?: string) => {
        const generation = authGeneration.current;
        const identity = identityRef.current;
        const { user: nextUser } = await updateAuthPassword(password, false, nonce);
        if (generation === authGeneration.current && identity === identityRef.current && nextUser.id === identity) applySessionUser(nextUser);
    }, [applySessionUser]);

    // A fresh object here re-renders every consumer of this context on every
    // provider render, sign-in state change or not. Each callback above is
    // itself memoized, so this only changes when user/authLoading/authError do.
    const value = useMemo<AuthContextType>(
        () => ({
            user,
            isAuthenticated: !!user,
            authLoading,
            authError,
            signOut,
            signInLocal,
            getAccessToken: async () => null,
            updateEmail,
            setPassword,
            refreshSession,
            retrySession: refreshSession,
        }),
        [
            user,
            authLoading,
            authError,
            signOut,
            signInLocal,
            updateEmail,
            setPassword,
            refreshSession,
        ],
    );

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useOptionalAuth() {
    return useContext(AuthContext);
}

export function useAuth() {
    const context = useOptionalAuth();
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
