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
import { describeNetworkFailure } from "../lib/networkError";
import { parseGoogleOAuthDialogMessage } from "./oauthProtocol";

export type AuthMode = "entra" | "local" | "supabase" | "unsupported";

const LOCAL_TOKEN_KEY = "mike_local_token";
// Set by an explicit Sign out so NAA / MSAL silent SSO doesn't immediately
// sign the pane back in on the next load; cleared by the next interactive
// sign-in.
const SIGNED_OUT_KEY = "mike_signed_out";
const SUPABASE_ACCESS_KEY = "mike_word_supabase_access";
const SUPABASE_REFRESH_KEY = "mike_word_supabase_refresh";
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY ?? "";

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

async function writeStorage(key: string, value: string | null): Promise<void> {
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
function storageSet(key: string, value: string | null): Promise<void> {
  const next = _storageOperation.then(() => writeStorage(key, value));
  _storageOperation = next.catch(() => undefined);
  return next;
}

// Module-level shared state. Every useAuth() instance and the API client read
// through these, and broadcast() re-renders all subscribed hooks on change.
// ---------------------------------------------------------------------------

// Upstream divergence (sync-log: 169ec3e4): apply session race protection
// around Entra/MSAL and local login instead of Supabase refresh tokens.
let _sessionGeneration = 0;
let _storageOperation: Promise<void> = Promise.resolve();
let _mode: AuthMode | null = null;
let _entra: EntraAuth | null = null;
let _supabaseRefreshToken: string | null = null;
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
  const generation = _sessionGeneration;
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
    if (generation === _sessionGeneration && stored) setToken({ accessToken: stored, expiresOn: null });
    return;
  }

  if (cfg.authProvider === "supabase") {
    _mode = "supabase";
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      _setupError = "Supabase sign-in is not configured for this add-in.";
      return;
    }
    try {
      const access = window.sessionStorage.getItem(SUPABASE_ACCESS_KEY);
      _supabaseRefreshToken = window.sessionStorage.getItem(SUPABASE_REFRESH_KEY);
      if (generation === _sessionGeneration && access) {
        setToken({ accessToken: access, expiresOn: jwtExpiresOn(access) });
      }
    } catch { /* Storage may be disabled; interactive login remains available. */ }
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
  const token = await _entra.acquireSilent();
  if (generation === _sessionGeneration) setToken(token);
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
  const generation = _sessionGeneration;
  if (_token && !isExpiring()) return _token;
  if (_mode === "entra" && _entra && _token) {
    const renewed = await _entra.acquireSilent();
    if (generation !== _sessionGeneration) return null;
    if (renewed) {
      setToken(renewed);
      return renewed.accessToken;
    }
  }
  if (_mode === "supabase" && _supabaseRefreshToken && (!_token || isExpiring())) {
    return refreshSession();
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
  const generation = _sessionGeneration;
  if (!_token) return null;
  if (_mode === "entra" && _entra) {
    const renewed = await _entra.acquireSilent(true);
    if (generation !== _sessionGeneration) return null;
    if (renewed) {
      setToken(renewed);
      return renewed.accessToken;
    }
  }
  if (_mode === "supabase" && _supabaseRefreshToken) {
    const refreshToken = _supabaseRefreshToken;
    let response: Response;
    try {
      response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch { return null; }
    if (generation !== _sessionGeneration || refreshToken !== _supabaseRefreshToken) return null;
    if (response.ok) {
      const data = await response.json() as { access_token?: string; refresh_token?: string };
      if (data.access_token && data.refresh_token) {
        await writeSession(data.access_token, data.refresh_token, generation);
        return data.access_token;
      }
    }
    clearSupabaseSession();
  }
  if (_mode === "local") await storageSet(LOCAL_TOKEN_KEY, null);
  if (generation === _sessionGeneration) setToken(null);
  return null;
}

// ---------------------------------------------------------------------------
// React-hook-facing auth actions
// ---------------------------------------------------------------------------

async function signInLocal(email: string, generation: number): Promise<void> {
  const url = `${API_BASE_URL}/auth/local-login`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (error) {
    throw new Error(describeNetworkFailure(error, { method: "POST", url }), { cause: error });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `Local login failed (${res.status})`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Local login returned no token");
  if (generation !== _sessionGeneration) return;
  await storageSet(LOCAL_TOKEN_KEY, data.token);
  if (generation !== _sessionGeneration) return;
  setToken({ accessToken: data.token, expiresOn: null });
}

function jwtExpiresOn(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch { return null; }
}

async function writeSession(access: string, refresh: string, generation: number): Promise<boolean> {
  if (generation !== _sessionGeneration) return false;
  _supabaseRefreshToken = refresh;
  try {
    window.sessionStorage.setItem(SUPABASE_ACCESS_KEY, access);
    window.sessionStorage.setItem(SUPABASE_REFRESH_KEY, refresh);
  } catch { /* In-memory session still applies. */ }
  if (generation !== _sessionGeneration) return false;
  setToken({ accessToken: access, expiresOn: jwtExpiresOn(access) });
  return true;
}

function clearSupabaseSession(): void {
  _supabaseRefreshToken = null;
  try {
    window.sessionStorage.removeItem(SUPABASE_ACCESS_KEY);
    window.sessionStorage.removeItem(SUPABASE_REFRESH_KEY);
  } catch { /* Storage may be disabled. */ }
  setToken(null);
}

async function signInSupabasePassword(email: string, password: string, generation: number): Promise<void> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error("Unable to sign in with those credentials.");
  const data = await response.json() as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) throw new Error("Sign-in returned an incomplete session.");
  await writeSession(data.access_token, data.refresh_token, generation);
}

/**
 * Interactive sign-in. Entra: Microsoft sign-in (NAA popup or Office dialog),
 * must run from a user gesture. Local: `email` is required.
 */
export async function signIn(email?: string, password?: string): Promise<void> {
  const generation = ++_sessionGeneration;
  _loading = true;
  _error = null;
  broadcast();

  try {
    await ensureReady();
    // A setup problem (unreachable server, unsupported mode, missing Entra
    // config) is already surfaced via getSessionState().error.
    if (_setupError || generation !== _sessionGeneration) return;
    if (_mode === "entra" && _entra) {
      const token = await _entra.acquireInteractive();
      if (generation !== _sessionGeneration) return;
      await storageSet(SIGNED_OUT_KEY, null);
      if (generation !== _sessionGeneration) return;
      setToken(token);
    } else if (_mode === "local") {
      if (!email) throw new Error("Enter an email address");
      await signInLocal(email, generation);
    } else if (_mode === "supabase") {
      if (!email || !password) throw new Error("Enter an email and password");
      await signInSupabasePassword(email, password, generation);
    }
  } catch (e) {
    if (generation !== _sessionGeneration) return;
    _error = e instanceof Error ? e.message : "Sign-in failed";
  } finally {
    if (generation !== _sessionGeneration) return;
    _loading = false;
    broadcast();
  }
}

function createOAuthRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/**
 * Authenticate in an Office Dialog. The dialog starts and finishes on the
 * add-in's own origin, while Google and Supabase occupy the intermediate
 * navigation steps. Only a validated Supabase session is accepted here.
 */
export async function signInWithGoogle(): Promise<void> {
  await ensureReady();
  if (_mode !== "supabase" || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    _error = "Google sign-in is available only with Supabase authentication.";
    broadcast();
    return;
  }
  const generation = ++_sessionGeneration;
  const requestId = createOAuthRequestId();
  const expectedOrigin = window.location.origin;
  const dialogUrl = new URL("/oauth-dialog.html", expectedOrigin);
  dialogUrl.searchParams.set("requestId", requestId);

  _loading = true;
  _error = null;
  broadcast();

  await new Promise<void>((resolve) => {
    let settled = false;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (generation === _sessionGeneration) {
        _loading = false;
        _error = message;
        broadcast();
      }
      resolve();
    };

    try {
      Office.context.ui.displayDialogAsync(
        dialogUrl.toString(),
        { height: 60, width: 45, displayInIframe: false },
        (result) => {
          if (result.status !== Office.AsyncResultStatus.Succeeded) {
            fail(result.error?.message ?? "Unable to open Google sign-in.");
            return;
          }

          const dialog = result.value;
          const close = (): void => {
            try {
              dialog.close();
            } catch {
              // The host may already have closed the dialog.
            }
          };

          dialog.addEventHandler(
            Office.EventType.DialogMessageReceived,
            (event) => {
              if (settled) return;
              if (!("message" in event)) return;
              if (event.origin && event.origin !== expectedOrigin) {
                close();
                fail("Google sign-in returned from an unexpected origin.");
                return;
              }

              const message = parseGoogleOAuthDialogMessage(event.message);
              if (!message || message.requestId !== requestId) {
                close();
                fail("Google sign-in returned an invalid response.");
                return;
              }

              if (message.status === "error") {
                close();
                fail(message.message);
                return;
              }

              settled = true;
              close();
              void writeSession(
                message.accessToken,
                message.refreshToken,
                generation
              ).then((saved) => {
                if (saved && generation === _sessionGeneration) {
                  _loading = false;
                  _error = null;
                  broadcast();
                }
                resolve();
              });
            }
          );

          dialog.addEventHandler(
            Office.EventType.DialogEventReceived,
            (event) => {
              if (!("error" in event)) return;
              fail(
                event.error === 12006
                  ? "Google sign-in was cancelled."
                  : `Google sign-in closed unexpectedly (Office error ${event.error}).`
              );
            }
          );
        }
      );
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : "Unable to open Google sign-in."
      );
    }
  });
}

export async function signOut(): Promise<void> {
  ++_sessionGeneration;
  _loading = false;
  _error = null;
  setToken(null);
  if (_mode === "supabase") clearSupabaseSession();
  if (_mode === "entra") {
    await storageSet(SIGNED_OUT_KEY, "1");
    await _entra?.signOut();
  }
  if (_mode === "local") await storageSet(LOCAL_TOKEN_KEY, null);
}
