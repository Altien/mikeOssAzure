import { useCallback, useEffect, useState } from "react";
import {
  getSessionState,
  initialize,
  signIn,
  signOut,
  subscribe,
  type AuthMode,
} from "./session";

// ---------------------------------------------------------------------------
// Thin React binding over the shared session store (auth/session.ts). All token
// state — including silent renewal — lives in that module so the bare API
// client can share it; this hook just subscribes mounted components to it.
// ---------------------------------------------------------------------------

export interface AuthState {
  token: string | null;
  loading: boolean;
  error: string | null;
  /** Backend auth mode from GET /config; null until known. */
  mode: AuthMode | null;
  /** Entra: Microsoft sign-in (no args). Local dev mode: pass the email. */
  login: (email?: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuth(): AuthState {
  // Counter-based forceUpdate: the session store, not local state, is the
  // source of truth — we just re-render when it broadcasts a change.
  const [, rerender] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribe(() => rerender((n) => n + 1));
    initialize();
    return unsubscribe;
  }, []);

  const login = useCallback((email?: string) => signIn(email), []);
  const logout = useCallback(() => signOut(), []);

  const { token, loading, error, mode } = getSessionState();
  return { token, loading, error, mode, login, logout };
}
