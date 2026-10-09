import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabaseSessionConfiguration } from "../../runtimeConfig";
import type { ServerCredential } from "../../serverSession";

function client(storage?: Map<string, string>): SupabaseClient {
  const { url, key } = supabaseSessionConfiguration();
  if (!url || !key) throw new Error("Supabase public authentication is unavailable");
  return createClient(url, key, {
    auth: {
      persistSession: !!storage,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      ...(storage ? { storage: {
        getItem: async (name: string) => storage.get(name) ?? null,
        setItem: async (name: string, value: string) => { storage.set(name, value); },
        removeItem: async (name: string) => { storage.delete(name); },
      } } : {}),
    },
  });
}

export function supabaseCredential(session: Session): ServerCredential {
  return {
    provider: "supabase", userId: session.user.id,
    accessToken: session.access_token, refreshToken: session.refresh_token,
  };
}

export function supabaseExpiresAt(session: Session): Date {
  return new Date((session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in) * 1000);
}

export function publicSupabaseUser(user: User) {
  return {
    id: user.id, email: user.email ?? "", pendingEmail: user.new_email ?? null,
    createdWithGoogle: user.app_metadata?.provider === "google",
  };
}

export function createSupabaseAuthClient() { return client(); }

export async function createCredentialClient(credential: ServerCredential) {
  if (credential.provider !== "supabase" || !credential.refreshToken) throw new Error("Supabase session is unavailable");
  const auth = client();
  const result = await auth.auth.setSession({ access_token: credential.accessToken, refresh_token: credential.refreshToken });
  if (result.error || !result.data.user || result.data.user.id !== credential.userId) throw new Error("Supabase session is invalid");
  return auth;
}

export async function renewSupabaseCredential(refreshToken: string) {
  const auth = client();
  const result = await auth.auth.refreshSession({ refresh_token: refreshToken });
  if (result.error || !result.data.session) throw new Error("Supabase refresh failed");
  return {
    accessToken: result.data.session.access_token,
    refreshToken: result.data.session.refresh_token,
    expiresAt: supabaseExpiresAt(result.data.session),
  };
}

export async function startSupabaseOAuth(redirectTo: string) {
  const storage = new Map<string, string>();
  const auth = client(storage);
  const result = await auth.auth.signInWithOAuth({ provider: "google", options: { redirectTo, skipBrowserRedirect: true } });
  if (result.error || !result.data.url) throw new Error("Google sign-in is unavailable");
  return { url: result.data.url, verifierState: JSON.stringify(Object.fromEntries(storage)) };
}

export async function startSupabaseSSO(domain: string, redirectTo: string) {
  const storage = new Map<string, string>();
  const auth = client(storage);
  const result = await auth.auth.signInWithSSO({ domain, options: { redirectTo, skipBrowserRedirect: true } });
  if (result.error || !result.data.url) throw new Error("SSO sign-in is unavailable");
  return { url: result.data.url, verifierState: JSON.stringify(Object.fromEntries(storage)) };
}

export async function startSupabaseRecovery(email: string, redirectTo: string) {
  const storage = new Map<string, string>();
  const auth = client(storage);
  const result = await auth.auth.resetPasswordForEmail(email, { redirectTo });
  if (result.error) throw new Error("Password recovery is unavailable");
  return JSON.stringify(Object.fromEntries(storage));
}

export async function exchangeSupabaseOAuth(code: string, verifierState: string) {
  const stored = JSON.parse(verifierState) as Record<string, unknown>;
  const storage = new Map<string, string>();
  for (const [name, value] of Object.entries(stored)) if (typeof value === "string") storage.set(name, value);
  const auth = client(storage);
  const result = await auth.auth.exchangeCodeForSession(code);
  if (result.error || !result.data.user || !result.data.session) throw new Error("Google sign-in exchange failed");
  return result.data;
}
