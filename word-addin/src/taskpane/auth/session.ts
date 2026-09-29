/// <reference types="office-js" />
/**
 * Single source of truth for the add-in's sign-in session.
 *
 * Dev-fork divergence (upstream sync b8bd5b0c): upstream signs in with a
 * Supabase password grant and refreshes via Supabase's token endpoint. This
 * fork authenticates the way the web frontend does, keyed off the backend's
 * runtime `GET /config`:
 *   - `entra`  — Microsoft Entra via MSAL.js (NAA, Office-dialog fallback);
 *                see ./entra.ts. The backend's Entra validator accepts the
 *                token exactly as it accepts the web frontend's.
 *   - `local`  — development-only email login (POST /api/auth/local-login),
 *                the same endpoint the web frontend's local mode uses.
 *   - `supabase` — NOT SUPPORTED in the add-in (dev deploys are Entra).
 * Do not reintroduce Supabase REST calls or build-time identity values here.
 *
 * The module keeps upstream's shape: the React hook (useAuth) and the API
 * client (api/mikeApi.ts) both read tokens through getFreshAccessToken() /
 * refreshSession(), and every change is broadcast to subscribed hooks, so a
 * failed refresh drops every view back to the login gate.
 */
import { EntraAuth, entraConfigProblem, type EntraToken } from "./entra";
import { API_BASE_URL, API_ORIGIN, loadRuntimeConfig } from "./runtimeConfig";

export type AuthMode = "entra" | "local" | "unsupported";

const LOCAL_TOKEN_KEY = "mike_local_token";
// Set by an explicit Sign out so NAA / MSAL silent SSO doesn't immediately
// sign the pane back in on the next load; cleared by the next interactive
// sign-in.
const SIGNED_OUT_KEY = "mike_signed_out";

// Refresh a little BEFORE the token's expiry so an in-flight request can't
// race the boundary (covers modest client/server clock skew too).
const EXPIRY_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------
// Persistence — OfficeRuntime.storage when the host provides it, else
// localStorage. Only the dev-only local token and the signed-out flag are
// stored here; Entra tokens live in MSAL's cache.
// ---------------------------------------------------------------------------

async function storageGet(key: string): Promise<string | null> {
  try {
    if (typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage) {
      return (await OfficeRuntime.storage.getItem(key)) ?? null;
    }
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function storageSet(key: string, value: string | null): Promise<void> {
  try {
    if (typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage) {
      if (value === null) await OfficeRuntime.storage.removeItem(key);
      else await OfficeRuntime.storage.setItem(key, value);
      return;
    }
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the in-memory session still applies.
  }
}

// ---------------------------------------------------------------------------
// Module-level shared state. Every useAuth() instance and the API client read
// through these, and broadcast() re-renders all subscribed hooks on change.
// ---------------------------------------------------------------------------

let _mode: AuthMode | null = null;
let _entra: EntraAuth | null = null;
let _token: string | null = null;
let _expiresOn: number | null = null;
let _loading = true;
let _error: string | null = null; // last sign-in attempt's failure
let _setupError: string | null = null; // why sign-in can't work at all

let _initialized = false;
let _readyPromise: Promise<void> | null = null;
let _refreshPromise: Promise<string | null> | null = null;

const _subscribers = new Set<() => void>();

function broadcast(): void {
  _subscribers.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  _subscribers.add(fn);
  return () => {
    _subscribers.delete(fn);
  };
}

export interface SessionState {
  token: string | null;
  loading: boolean;
  error: string | null;
  mode: AuthMode | null;
}

export function getSessionState(): SessionState {
  return {
    token: _token,
    loading: _loading,
    error: _error ?? _setupError,
    mode: _mode,
  };
}

function setToken(token: EntraToken | { accessToken: string; expiresOn: null } | null): void {
  _token = token?.accessToken ?? null;
  _expiresOn = token?.expiresOn ?? null;
  broadcast();
}

function isExpiring(): boolean {
  return _expiresOn !== null && Date.now() >= _expiresOn - EXPIRY_SKEW_MS;
}

// ---------------------------------------------------------------------------
// Startup: read /config, pick the mode, try a silent sign-in.
// ---------------------------------------------------------------------------

async function prepare(): Promise<void> {
  let cfg;
  try {
    cfg = await loadRuntimeConfig();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't reach the Mike server at ${API_ORIGIN} (${detail}).`);
  }

  if (cfg.authProvider === "local") {
    _mode = "local";
    const stored = await storageGet(LOCAL_TOKEN_KEY);
    if (stored) setToken({ accessToken: stored, expiresOn: null });
    return;
  }

  if (cfg.authProvider !== "entra") {
    // Upstream divergence (sync-log: b8bd5b0c): NOT SUPPORTED — Supabase
    // sign-in was removed from the add-in; dev deployments are Entra.
    _mode = "unsupported";
    _setupError =
      "This Mike server uses Supabase sign-in, which the Word add-in does not support. " +
      "Use AUTH_PROVIDER=entra (or local for development).";
    return;
  }

  _mode = "entra";
  _setupError = entraConfigProblem(cfg);
  if (_setupError) return;
  _entra = await EntraAuth.create(cfg);
  if ((await storageGet(SIGNED_OUT_KEY)) === "1") return;
  setToken(await _entra.acquireSilent());
}

/** Resolve once the mode is known; a failed /config read is retried next call. */
function ensureReady(): Promise<void> {
  if (!_readyPromise) {
    _setupError = null;
    _readyPromise = prepare().catch((e: unknown) => {
      _readyPromise = null;
      _setupError = e instanceof Error ? e.message : "Sign-in is unavailable";
    });
  }
  return _readyPromise;
}

/** Kick off the one-time startup, flipping `loading` false when done. */
export function initialize(): void {
  if (_initialized) return;
  _initialized = true;
  void ensureReady().then(() => {
    _loading = false;
    broadcast();
  });
}

// ---------------------------------------------------------------------------
// Token acquisition (API client)
// ---------------------------------------------------------------------------

/**
 * Return a usable access token for an outgoing API request, renewing it
 * silently first when it is about to expire. May return null (signed out /
 * renewal impossible), in which case the request 401s and the reactive path
 * (refreshSession) takes over.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  await ensureReady();
  if (_token && !isExpiring()) return _token;
  if (_mode === "entra" && _entra && _token) {
    const renewed = await _entra.acquireSilent();
    if (renewed) {
      setToken(renewed);
      return renewed.accessToken;
    }
  }
  return _token;
}

/**
 * Called after the API answered 401. Entra: force a silent renewal once;
 * local: the dev token can't be renewed. On failure the session is cleared
 * so the UI returns to the login gate instead of looping on 401s.
 * Concurrent callers share a single attempt.
 */
export function refreshSession(): Promise<string | null> {
  if (!_refreshPromise) {
    _refreshPromise = doRefresh().finally(() => {
      _refreshPromise = null;
    });
  }
  return _refreshPromise;
}

async function doRefresh(): Promise<string | null> {
  await ensureReady();
  if (_mode === "entra" && _entra) {
    const renewed = await _entra.acquireSilent(true);
    if (renewed) {
      setToken(renewed);
      return renewed.accessToken;
    }
  }
  if (_mode === "local") await storageSet(LOCAL_TOKEN_KEY, null);
  setToken(null);
  return null;
}

// ---------------------------------------------------------------------------
// React-hook-facing auth actions
// ---------------------------------------------------------------------------

async function signInLocal(email: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/auth/local-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `Local login failed (${res.status})`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Local login returned no token");
  await storageSet(LOCAL_TOKEN_KEY, data.token);
  setToken({ accessToken: data.token, expiresOn: null });
}

/**
 * Interactive sign-in. Entra: Microsoft sign-in (NAA popup or Office dialog),
 * must run from a user gesture. Local: `email` is required.
 */
export async function signIn(email?: string): Promise<void> {
  _loading = true;
  _error = null;
  broadcast();

  try {
    await ensureReady();
    // A setup problem (unreachable server, unsupported mode, missing Entra
    // config) is already surfaced via getSessionState().error.
    if (_setupError) return;
    if (_mode === "entra" && _entra) {
      const token = await _entra.acquireInteractive();
      await storageSet(SIGNED_OUT_KEY, null);
      setToken(token);
    } else if (_mode === "local") {
      if (!email) throw new Error("Enter an email address");
      await signInLocal(email);
    }
  } catch (e) {
    _error = e instanceof Error ? e.message : "Sign-in failed";
  } finally {
    _loading = false;
    broadcast();
  }
}

export async function signOut(): Promise<void> {
  _error = null;
  if (_mode === "entra") {
    await storageSet(SIGNED_OUT_KEY, "1");
    await _entra?.signOut();
  }
  if (_mode === "local") await storageSet(LOCAL_TOKEN_KEY, null);
  setToken(null);
}
