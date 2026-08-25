import { AUTH_SESSION_INVALIDATED_EVENT } from "@/app/lib/authEvents";

// Names remain only to clear credentials written by older releases.
export const ENTRA_TOKEN_KEY = "mike.entra.access_token";
export const ENTRA_USER_KEY = "mike.entra.user";
export const LOCAL_TOKEN_KEY = "mike.local.access_token";
export const LOCAL_USER_KEY = "mike.local.user";

/** Compatibility seam while direct callers move to credentialed fetch. */
export async function getBrowserAccessToken(): Promise<null> { return null; }

export function clearStoredAuthState(): void {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (const name of [ENTRA_TOKEN_KEY, ENTRA_USER_KEY, LOCAL_TOKEN_KEY, LOCAL_USER_KEY]) storage.removeItem(name);
  }
}

export function bounceIfUnauthorized(response: Response): void {
  if (response.status !== 401) return;
  if (typeof window !== "undefined") {
    clearStoredAuthState();
    window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
  }
  throw new Error("Authentication required");
}
