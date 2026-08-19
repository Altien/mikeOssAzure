"use client";
import { browserAuthCallbackUrl } from "@/app/lib/authRedirects";

import React, { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/app/lib/supabase";
import { useConfig, useConfigLoading } from "@/app/contexts/ConfigContext";
import {
  ENTRA_TOKEN_KEY,
  ENTRA_USER_KEY,
  LOCAL_TOKEN_KEY,
  LOCAL_USER_KEY,
  getBrowserAccessToken,
} from "@/app/lib/auth-token";

interface User { id: string; email: string; pendingEmail?: string | null; }
interface AuthContextType {
  user: User | null; isAuthenticated: boolean; authLoading: boolean;
  signInLocal: (email: string) => Promise<void>;
  signOut: () => Promise<void>; getAccessToken: () => Promise<string | null>;
  // Upstream's account page changes email through Supabase Auth. Only the
  // supabase mode can do that; in entra/local modes the identity provider
  // owns the address, so updateEmail rejects with an explanatory error.
  updateEmail: (email: string) => Promise<User>;
}
// Exported for the test harness (src/test/render.tsx) to inject auth state.
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

function toSupabaseUser(user: SupabaseUser): User {
  return { id: user.id, email: user.email || "", pendingEmail: user.new_email ?? null };
}

function decodeJwtUser(token: string): User {
  const payload = token.split(".")[1];
  if (!payload) return { id: "entra-user", email: "" };

  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/"))) as {
      oid?: unknown;
      sub?: unknown;
      preferred_username?: unknown;
      email?: unknown;
      upn?: unknown;
    };
    const id = typeof claims.oid === "string"
      ? claims.oid
      : typeof claims.sub === "string"
        ? claims.sub
        : "entra-user";
    const email = typeof claims.preferred_username === "string"
      ? claims.preferred_username
      : typeof claims.email === "string"
        ? claims.email
        : typeof claims.upn === "string"
          ? claims.upn
          : "";
    return { id, email: email.toLowerCase() };
  } catch {
    return { id: "entra-user", email: "" };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const configLoading = useConfigLoading();
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    // Wait for /config to resolve before deciding which auth flow to
    // run.  Until then we stay in `authLoading=true`, which gates the
    // login page redirect / authenticated-route guards downstream.
    if (configLoading) return;

    const provider = config.authProvider;

    if (provider === "supabase") {
      const supabase = getSupabaseClient();
      const checkUser = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) setUser(toSupabaseUser(session.user));
        setAuthLoading(false);
      };
      checkUser();
      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
        setUser(session?.user ? toSupabaseUser(session.user) : null);
        setAuthLoading(false);
      });
      return () => subscription.unsubscribe();
    }

    if (provider === "local") {
      const storedUser = localStorage.getItem(LOCAL_USER_KEY);
      if (storedUser) {
        try {
          setUser(JSON.parse(storedUser));
        } catch {
          localStorage.removeItem(LOCAL_USER_KEY);
          localStorage.removeItem(LOCAL_TOKEN_KEY);
        }
      }
      setAuthLoading(false);
      return;
    }

    // entra
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = hash.get("access_token");
    if (token) {
      localStorage.setItem(ENTRA_TOKEN_KEY, token);
      const tokenUser = decodeJwtUser(token);
      localStorage.setItem(ENTRA_USER_KEY, JSON.stringify(tokenUser));
      setUser(tokenUser);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } else {
      const storedUser = localStorage.getItem(ENTRA_USER_KEY);
      if (storedUser) {
        try {
          setUser(JSON.parse(storedUser));
        } catch {
          localStorage.removeItem(ENTRA_USER_KEY);
          localStorage.removeItem(ENTRA_TOKEN_KEY);
        }
      }
    }
    setAuthLoading(false);
  }, [config, configLoading]);

  const getAccessToken = async (): Promise<string | null> => {
    return getBrowserAccessToken();
  };

  const signInLocal = async (email: string): Promise<void> => {
    const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") + "/api";
    const response = await fetch(`${apiBase}/auth/local-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { token: string; user: User };
    localStorage.setItem(LOCAL_TOKEN_KEY, payload.token);
    localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(payload.user));
    setUser(payload.user);
  };

  const signOut = async () => {
    const provider = config.authProvider;

    if (provider === "local") {
      localStorage.removeItem(LOCAL_TOKEN_KEY);
      localStorage.removeItem(LOCAL_USER_KEY);
      setUser(null);
      return;
    }

    if (provider === "supabase") {
      const supabase = getSupabaseClient();
      await supabase.auth.signOut();
      setUser(null);
      return;
    }

    // entra — clear local state and let the backend redirect through
    // Microsoft's logout endpoint so the IdP session is also cleared.
    localStorage.removeItem(ENTRA_TOKEN_KEY);
    localStorage.removeItem(ENTRA_USER_KEY);
    setUser(null);
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
    // Router is mounted at /api/auth (app.ts); the bare /auth path fell
    // through to the SPA shell and never signed out.
    window.location.href = `${apiBase}/api/auth/logout`;
  };

  const updateEmail = async (email: string): Promise<User> => {
    if (config.authProvider !== "supabase") {
      throw new Error(
        "Your email address is managed by your organisation's sign-in provider and cannot be changed here.",
      );
    }
    const supabase = getSupabaseClient();
    const redirectTo = typeof window === "undefined" ? undefined : browserAuthCallbackUrl("/settings?emailChange=processed");
    const { data, error } = await supabase.auth.updateUser(
      { email },
      redirectTo ? { emailRedirectTo: redirectTo } : undefined,
    );
    if (error) throw error;
    if (!data.user) throw new Error("Unable to update email");
    const nextUser = toSupabaseUser(data.user);
    setUser(nextUser);
    return nextUser;
  };

  return <AuthContext.Provider value={{ user, isAuthenticated: !!user, authLoading: authLoading || configLoading, signInLocal, signOut, getAccessToken, updateEmail }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
