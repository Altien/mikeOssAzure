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
import { clearToasts } from "@mike/ui";

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
/** Retry delays for a session check the server could not answer. */
const SESSION_RETRY_BASE_MS = 1_000;
const SESSION_RETRY_MAX_MS = 30_000;

/**
 * Did the session check fail because the server could not answer (a 5xx such
 * as 503 upstream_unavailable while GoTrue or the API is down, or no response
 * at all), rather than answer "no session"? Then nobody knows whether the
 * user is signed in, and treating them as signed out would send a working
 * session to the login page. A 401 never gets here: getAuthSession answers
 * null for it.
 */
function isTransientSessionFailure(error: unknown): boolean {
    // An AuthApiError carries the HTTP status (read by shape, so a test that
    // mocks the auth client needs no class).
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number") return status >= 500;
    // fetch rejects with a TypeError when no response arrives.
    return error instanceof TypeError;
}

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

    // Background session checks (focus, tab visibility, another tab signing
    // in) have no screen of their own: without this the user sees a silently
    // stale session, so the failure gets a toast with a real Retry.
    // Upstream divergence (sync-log: f1e8dffa): Dev keeps its generation
    // fences around upstream's retrying check: a toast Retry or a pending
    // backoff retry from an ended session (sign-out, invalidation, another
    // tab) never runs against the next one.
    const checkSessionRef = useRef<(notify: boolean) => Promise<void>>(
        async () => {},
    );
    const reportSessionFailure = useCallback((error: unknown, generation: number) => {
        if (generation !== authGeneration.current) return;
        setAuthError(SESSION_ERROR_MESSAGE);
        // Sign-in screens show `authError` themselves, with their own
        // Retry; a toast there repeated it and then contradicted the
        // form's next error.
        if (isOnAuthRoute()) return;
        notifyError(error, {
            action: "check your session",
            dedupeKey: "auth-session",
            onRetry: () => {
                if (generation !== authGeneration.current) return;
                void checkSessionRef.current(true);
            },
        });
    }, []);

    // A check the server could not answer keeps the auth state it had (the
    // signed-in user, or "still loading" on a fresh page load, which keeps
    // the app's loader up instead of redirecting to the login page) and is
    // retried with backoff until the server answers. One notice per failing
    // streak: the retries update it silently.
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryAttemptRef = useRef(0);
    const checkSession = useCallback(
        async (notify: boolean) => {
            if (retryTimerRef.current !== null) {
                clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
            const generation = authGeneration.current;
            try {
                await fetchAndApplySession();
                retryAttemptRef.current = 0;
                setAuthLoading(false);
            } catch (error) {
                // fetchAndApplySession only throws for the current generation.
                const firstOfStreak = retryAttemptRef.current === 0;
                if (isTransientSessionFailure(error)) {
                    const delay = Math.min(
                        SESSION_RETRY_MAX_MS,
                        SESSION_RETRY_BASE_MS * 2 ** retryAttemptRef.current,
                    );
                    retryAttemptRef.current += 1;
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null;
                        if (generation !== authGeneration.current) {
                            retryAttemptRef.current = 0;
                            return;
                        }
                        void checkSessionRef.current(false);
                    }, delay);
                } else {
                    retryAttemptRef.current = 0;
                    setAuthLoading(false);
                }
                if (notify || firstOfStreak) reportSessionFailure(error, generation);
                else if (generation === authGeneration.current) setAuthError(SESSION_ERROR_MESSAGE);
            }
        },
        [fetchAndApplySession, reportSessionFailure],
    );

    useEffect(() => {
        checkSessionRef.current = checkSession;
    }, [checkSession]);

    useEffect(
        () => () => {
            if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
        },
        [],
    );

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
            void checkSession(true);
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
            void checkSession(false);
        };
        const onFocus = () => {
            void checkSession(false);
        };

        channel?.addEventListener("message", onChannelMessage);
        window.addEventListener("storage", onStorage);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, onInvalidated);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibilityChange);

        // Through the ref (assigned by the effect above, which runs first):
        // the check only sets state after its request settles.
        void checkSessionRef.current(true);

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
    }, [applySessionUser, broadcastAuthState, checkSession]);

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
