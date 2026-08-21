"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from "react";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { supabase } from "@/app/lib/supabase";
import { browserAuthCallbackUrl } from "@/app/lib/authRedirects";

interface User {
    id: string;
    email: string;
    pendingEmail?: string | null;
    createdWithGoogle: boolean;
    hasPassword: boolean;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
    updateEmail: (email: string) => Promise<User>;
    setPassword: (password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function authMethodState(
    user: Pick<SupabaseUser, "app_metadata" | "identities">,
) {
    const primaryProvider =
        typeof user.app_metadata?.provider === "string"
            ? user.app_metadata.provider
            : null;
    const metadataProviders = Array.isArray(user.app_metadata?.providers)
        ? user.app_metadata.providers.filter(
              (provider): provider is string => typeof provider === "string",
          )
        : [];
    const identityProviders = Array.isArray(user.identities)
        ? user.identities.map((identity) => identity.provider)
        : [];
    const providers = new Set([
        ...(primaryProvider ? [primaryProvider] : []),
        ...metadataProviders,
        ...identityProviders,
    ]);

    return {
        createdWithGoogle: primaryProvider === "google",
        hasPassword: providers.has("email"),
    };
}

function toUser(user: SupabaseUser): User {
    return {
        id: user.id,
        email: user.email || "",
        pendingEmail: user.new_email ?? null,
        ...authMethodState(user),
    };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    useEffect(() => {
        const checkUser = async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();

            if (session?.user) {
                setUser(toUser(session.user));
            }
            setAuthLoading(false);
        };

        checkUser();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange(async (_event, session) => {
            if (session?.user) {
                setUser(toUser(session.user));
            } else {
                setUser(null);
            }
            setAuthLoading(false);
        });

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    const signOut = async () => {
        await supabase.auth.signOut({ scope: "local" });
        setUser(null);
    };

    const updateEmail = async (email: string) => {
        const redirectTo = browserAuthCallbackUrl(
            "/settings?emailChange=processed",
        );
        const { data, error } = await supabase.auth.updateUser(
            { email },
            redirectTo ? { emailRedirectTo: redirectTo } : undefined,
        );

        if (error) throw error;
        if (!data.user) throw new Error("Unable to update email");

        const nextUser = toUser(data.user);
        setUser(nextUser);
        return nextUser;
    };

    const setPassword = async (password: string) => {
        const { data, error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        if (!data.user) throw new Error("Unable to set password");

        setUser({ ...toUser(data.user), hasPassword: true });
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                signOut,
                updateEmail,
                setPassword,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
