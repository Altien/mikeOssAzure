"use client";

import React, { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { getSupabaseClient } from "@/lib/supabase";
import { useConfig, useConfigLoading } from "@/contexts/ConfigContext";
import {
  ENTRA_TOKEN_KEY,
  ENTRA_USER_KEY,
  LOCAL_TOKEN_KEY,
  LOCAL_USER_KEY,
  getBrowserAccessToken,
} from "@/lib/auth-token";

interface User { id: string; email: string; }
interface AuthContextType {
  user: User | null; isAuthenticated: boolean; authLoading: boolean;
  signInLocal: (email: string) => Promise<void>;
  signOut: () => Promise<void>; getAccessToken: () => Promise<string | null>;
}
const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
        if (session?.user) setUser({ id: session.user.id, email: session.user.email || "" });
        setAuthLoading(false);
      };
      checkUser();
      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
        setUser(session?.user ? { id: session.user.id, email: session.user.email || "" } : null);
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
    window.location.href = `${apiBase}/auth/logout`;
  };

  return <AuthContext.Provider value={{ user, isAuthenticated: !!user, authLoading: authLoading || configLoading, signInLocal, signOut, getAccessToken }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
