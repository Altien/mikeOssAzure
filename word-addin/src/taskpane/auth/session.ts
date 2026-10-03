/// <reference types="office-js" />
import { describeNetworkFailure } from "../lib/networkError";
import { parseGoogleOAuthDialogMessage } from "./oauthProtocol";
import { EntraAuth, entraConfigProblem } from "./entra";
import { API_BASE_URL, loadRuntimeConfig, type AuthProvider } from "./runtimeConfig";

const LEGACY_ACCESS_KEY = "mike_token";
const LEGACY_REFRESH_KEY = "mike_refresh_token";
const API_BASE = API_BASE_URL;
const SIGNED_OUT_KEY = "mike_signed_out";

export interface AddinAuthUser {
  id: string;
  email: string;
  pendingEmail: string | null;
  createdWithGoogle: boolean;
}

interface SessionState {
  user: AddinAuthUser | null;
  loading: boolean;
  error: string | null;
  mode: AuthProvider | null;
}

let _user: AddinAuthUser | null = null;
let _loading = true;
let _error: string | null = null;
let _initialized = false;
let _sessionGeneration = 0;
let _sessionPromise: Promise<AddinAuthUser | null> | null = null;
let _mode: AuthProvider | null = null;
let _entra: EntraAuth | null = null;
const _subscribers = new Set<() => void>();

function broadcast(): void {
  _subscribers.forEach((subscriber) => subscriber());
}

export function subscribe(fn: () => void): () => void {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

export function getSessionState(): SessionState {
  return { user: _user, loading: _loading, error: _error, mode: _mode };
}

async function clearLegacyTokenStorage(): Promise<void> {
  await Promise.all([
    OfficeRuntime.storage.removeItem(LEGACY_ACCESS_KEY).catch(() => {}),
    OfficeRuntime.storage.removeItem(LEGACY_REFRESH_KEY).catch(() => {}),
  ]);
}

async function parseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  return typeof body.detail === "string" && body.detail
    ? `${body.detail} (HTTP ${response.status}).`
    : `Authentication failed (HTTP ${response.status}).`;
}

async function requestSession(): Promise<AddinAuthUser | null> {
  const url = `${API_BASE}/auth/session`;
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(describeNetworkFailure(error, { method: "GET", url }), {
      cause: error,
    });
  }
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { user: AddinAuthUser };
  return body.user;
}

async function bootstrapEntraSession(accessToken: string): Promise<void> {
  const bootstrap = await fetch(`${API_BASE}/auth/bootstrap`, {
    method: "POST", credentials: "include", headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!bootstrap.ok) throw new Error(await parseError(bootstrap));
}

async function requestOrBootstrapSession(generation: number): Promise<AddinAuthUser | null> {
  const current = await requestSession();
  if (current || generation !== _sessionGeneration || _mode !== "entra" || !_entra?.supportsNestedAuthentication) return current;
  if (await OfficeRuntime.storage.getItem(SIGNED_OUT_KEY) === "1") return null;
  const token = await _entra.acquireSilent();
  if (!token || generation !== _sessionGeneration) return null;
  await bootstrapEntraSession(token.accessToken);
  return generation === _sessionGeneration ? requestSession() : null;
}

async function redeemAuthHandoff(
  ticket: string,
  requestId: string,
): Promise<AddinAuthUser> {
  const url = `${API_BASE}/auth/handoff`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, requestId }),
    });
  } catch (error) {
    throw new Error(describeNetworkFailure(error, { method: "POST", url }), {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { user: AddinAuthUser };
  const confirmed = await requestSession();
  if (!confirmed || confirmed.id !== body.user.id) throw new Error("Word could not retain the sign-in cookie. Enable cookies for this add-in host.");
  return confirmed;
}

async function signInWithMicrosoftDialog(generation: number): Promise<void> {
  const backendOrigin = window.location.origin;
  const requestId = createOAuthRequestId();
  const dialogUrl = new URL("/oauth-dialog.html", window.location.origin);
  dialogUrl.searchParams.set("provider", "microsoft");
  dialogUrl.searchParams.set("requestId", requestId);
  const ticket = await new Promise<string>((resolve, reject) => {
    let settled = false;
    Office.context.ui.displayDialogAsync(dialogUrl.toString(), { height: 60, width: 45, displayInIframe: false }, result => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) { reject(new Error(result.error?.message || "Unable to open Microsoft sign-in")); return; }
      const dialog = result.value;
      const settle = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        dialog.close();
        if (error) reject(error); else resolve(value!);
      };
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, event => {
        if (!("message" in event) || event.origin !== backendOrigin) { settle(new Error("Microsoft sign-in returned from an unexpected origin")); return; }
        let payload: unknown;
        try { payload = JSON.parse(event.message); } catch { settle(new Error("Malformed Microsoft sign-in response")); return; }
        const message = payload as { type?: unknown; requestId?: unknown; status?: unknown; handoffTicket?: unknown };
        if (message.type !== "mike-word-handoff" || message.requestId !== requestId || message.status !== "success" || typeof message.handoffTicket !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(message.handoffTicket)) {
          settle(new Error("Invalid Microsoft sign-in handoff")); return;
        }
        settle(undefined, message.handoffTicket);
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, event => settle(new Error("error" in event && event.error === 12006 ? "Microsoft sign-in was cancelled" : "Microsoft sign-in dialog closed")));
    });
  });
  if (generation !== _sessionGeneration) return;
  const user = await redeemAuthHandoff(ticket, requestId);
  if (generation !== _sessionGeneration) return;
  await OfficeRuntime.storage.removeItem(SIGNED_OUT_KEY);
  _user = user;
}

export function refreshSession(): Promise<AddinAuthUser | null> {
  const generation = _sessionGeneration;
  if (!_sessionPromise) {
    _sessionPromise = requestOrBootstrapSession(generation).finally(() => {
      _sessionPromise = null;
    });
  }
  return _sessionPromise.then((user) => {
    if (generation !== _sessionGeneration) return null;
    _user = user;
    _error = null;
    broadcast();
    return user;
  });
}

export function initialize(): void {
  if (_initialized) return;
  _initialized = true;
  void clearLegacyTokenStorage()
    .then(async () => {
      const config = await loadRuntimeConfig();
      _mode = config.authProvider;
      if (_mode === "entra") {
        const problem = entraConfigProblem(config);
        if (problem) throw new Error(problem);
        _entra = await EntraAuth.create(config);
      }
      await refreshSession();
    })
    .catch((error: unknown) => {
      _user = null;
      _error = error instanceof Error ? error.message : "Login failed";
    })
    .finally(() => {
      _loading = false;
      broadcast();
    });
}

export async function signIn(email?: string, password?: string): Promise<void> {
  const generation = ++_sessionGeneration;
  _loading = true;
  _error = null;
  broadcast();
  const url = `${API_BASE}/auth/${_mode === "local" ? "local-login" : "login"}`;

  try {
    if (_mode === "entra") {
      if (!_entra) throw new Error("Microsoft sign-in is unavailable");
      if (!_entra.supportsNestedAuthentication) {
        await signInWithMicrosoftDialog(generation);
        return;
      }
      const token = await _entra.acquireInteractive();
      if (generation !== _sessionGeneration) return;
      await bootstrapEntraSession(token.accessToken);
      const user = await requestSession();
      if (generation !== _sessionGeneration || !user) throw new Error("Word could not retain the sign-in cookie. Enable cookies for this add-in host.");
      await OfficeRuntime.storage.removeItem(SIGNED_OUT_KEY);
      _user = user;
      return;
    }
    if (!email || (_mode === "supabase" && !password)) throw new Error("Enter your credentials");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(_mode === "local" ? { email } : { email, password }),
      });
    } catch (error) {
      throw new Error(describeNetworkFailure(error, { method: "POST", url }), {
        cause: error,
      });
    }
    if (!response.ok) throw new Error(await parseError(response));
    await response.json();
    if (generation !== _sessionGeneration) return;
    const confirmed = await requestSession();
    if (!confirmed) throw new Error("Word could not retain the sign-in cookie. Enable cookies for this add-in host.");
    _user = confirmed;
  } catch (error) {
    if (generation !== _sessionGeneration) return;
    _user = null;
    _error = error instanceof Error ? error.message : "Login failed";
  } finally {
    if (generation === _sessionGeneration) {
      _loading = false;
      broadcast();
    }
  }
}

function createOAuthRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function signInWithGoogle(): Promise<void> {
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
              if (settled || !("message" in event)) return;
              if (event.origin !== expectedOrigin) {
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
              void redeemAuthHandoff(message.handoffTicket, requestId)
                .then((user) => {
                  if (generation === _sessionGeneration) {
                    _user = user;
                    _error = null;
                  }
                })
                .catch((error: unknown) => {
                  if (generation === _sessionGeneration) {
                    _error =
                      error instanceof Error
                        ? error.message
                        : "Unable to complete Google sign-in.";
                  }
                })
                .finally(() => {
                  if (generation === _sessionGeneration) _loading = false;
                  broadcast();
                  resolve();
                });
            },
          );

          dialog.addEventHandler(
            Office.EventType.DialogEventReceived,
            (event) => {
              if (!("error" in event)) return;
              fail(
                event.error === 12006
                  ? "Google sign-in was cancelled."
                  : `Google sign-in closed unexpectedly (Office error ${event.error}).`,
              );
            },
          );
        },
      );
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : "Unable to open Google sign-in.",
      );
    }
  }).finally(() => {
    if (generation === _sessionGeneration && _loading) {
      _loading = false;
      broadcast();
    }
  });
}

export async function signOut(): Promise<void> {
  const generation = ++_sessionGeneration;
  _error = null;
  const url = `${API_BASE}/auth/logout`;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "local" }),
      });
    } catch (error) {
      throw new Error(describeNetworkFailure(error, { method: "POST", url }), {
        cause: error,
      });
    }
    if (!response.ok) throw new Error(await parseError(response));
    if (generation !== _sessionGeneration) return;
    _user = null;
    await clearLegacyTokenStorage();
    await OfficeRuntime.storage.setItem(SIGNED_OUT_KEY, "1");
  } catch (error) {
    if (generation !== _sessionGeneration) return;
    _error =
      error instanceof Error
        ? error.message
        : "Unable to sign out. Please try again.";
  }
  broadcast();
}
