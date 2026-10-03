import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_SESSION_INVALIDATED_EVENT } from "./authEvents";
import {
    ENTRA_TOKEN_KEY, ENTRA_USER_KEY, LOCAL_TOKEN_KEY, LOCAL_USER_KEY,
    getBrowserAccessToken, clearStoredAuthState, bounceIfUnauthorized,
} from "./auth-token";

describe("legacy browser credentials during cookie auth", () => {
    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
    });

    it("never exposes stored Entra, local, or Supabase bearer credentials", async () => {
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "old-entra-secret");
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "old-local-secret");
        window.localStorage.setItem("sb-auth-token", "old-supabase-secret");
        await expect(getBrowserAccessToken()).resolves.toBeNull();
    });

    it("clears only legacy auth keys from both browser storage areas", () => {
        const keys = [ENTRA_TOKEN_KEY, ENTRA_USER_KEY, LOCAL_TOKEN_KEY, LOCAL_USER_KEY];
        for (const storage of [window.localStorage, window.sessionStorage]) {
            for (const key of keys) storage.setItem(key, "legacy");
            storage.setItem("mike.user.preferences", "{}");
        }
        clearStoredAuthState();
        clearStoredAuthState();
        for (const storage of [window.localStorage, window.sessionStorage]) {
            for (const key of keys) expect(storage.getItem(key)).toBeNull();
            expect(storage.getItem("mike.user.preferences")).toBe("{}");
        }
    });

    it("signals the auth context on 401 without writing a login URL or token", () => {
        const listener = vi.fn();
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "legacy");
        const before = window.location.href;
        expect(() => bounceIfUnauthorized({ status: 401 } as Response)).toThrow("Authentication required");
        expect(listener).toHaveBeenCalledOnce();
        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBeNull();
        expect(window.location.href).toBe(before);
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    });

    it("does not invalidate a session for unrelated HTTP statuses", () => {
        const listener = vi.fn();
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        for (const status of [200, 400, 403, 500]) {
            expect(() => bounceIfUnauthorized({ status } as Response)).not.toThrow();
        }
        expect(listener).not.toHaveBeenCalled();
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    });
});
