import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearLegacyBrowserAuthStorage,
    getAuthSession,
    listMfaFactors,
    login,
    logout,
    requestPasswordReset,
    signup,
    startGoogleOAuth,
} from "./authApi";

const fetchMock = vi.fn();
const localUser = {
    id: "user-1",
    email: "lawyer@example.test",
    pendingEmail: null,
};

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("SQLite auth facade", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        window.localStorage.clear();
        window.sessionStorage.clear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("logs in through the SQLite endpoint and maps the local user", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ token: "local-token", user: localUser }),
        );

        await expect(login(localUser.email, "correct horse")).resolves.toEqual({
            user: {
                ...localUser,
                createdWithGoogle: false,
            },
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/login",
            expect.objectContaining({
                method: "POST",
                cache: "no-store",
                body: JSON.stringify({
                    email: localUser.email,
                    password: "correct horse",
                }),
            }),
        );
        expect(window.localStorage.getItem("mike_auth_token")).toBe(
            "local-token",
        );
    });

    it("loads the bearer-token session from the SQLite backend", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        fetchMock.mockResolvedValue(jsonResponse({ user: localUser }));

        await expect(getAuthSession()).resolves.toEqual({
            ...localUser,
            createdWithGoogle: false,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/session",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer local-token",
                }),
            }),
        );
    });

    it("does not request a session when no local token exists", async () => {
        await expect(getAuthSession()).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("signs up locally without requiring email confirmation", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ token: "signup-token", user: localUser }),
        );

        await expect(
            signup(localUser.email, "long-password", "/onboarding/profile"),
        ).resolves.toEqual({
            user: { ...localUser, createdWithGoogle: false },
            requiresEmailConfirmation: false,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/signup",
            expect.objectContaining({ method: "POST" }),
        );
    });

    it("logs out through SQLite and clears the bearer token", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await logout();

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/logout",
            expect.objectContaining({ method: "POST" }),
        );
        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();
    });

    it("uses the SQLite MFA adapter", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        fetchMock.mockResolvedValue(
            jsonResponse({
                factors: [
                    {
                        id: "factor-1",
                        factor_type: "totp",
                        status: "verified",
                    },
                ],
                currentLevel: "aal2",
                nextLevel: "aal2",
            }),
        );

        await expect(listMfaFactors()).resolves.toEqual({
            all: [
                {
                    id: "factor-1",
                    factor_type: "totp",
                    status: "verified",
                },
            ],
            totp: [
                {
                    id: "factor-1",
                    factor_type: "totp",
                    status: "verified",
                },
            ],
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/mfa/status",
            expect.any(Object),
        );
    });

    it("rejects auth features that SQLite does not implement", async () => {
        await expect(startGoogleOAuth("/onboarding/profile")).rejects.toEqual(
            expect.objectContaining({
                code: "local_auth_unsupported",
                message:
                    "Google sign-in is unavailable with SQLite authentication.",
            }),
        );
        await expect(requestPasswordReset(localUser.email)).rejects.toEqual(
            expect.objectContaining({
                code: "local_auth_unsupported",
            }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("removes obsolete hosted-auth sessions but preserves the SQLite token", () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        window.localStorage.setItem("sb-project-auth-token", "obsolete-token");
        window.sessionStorage.setItem("supabase.auth.session", "obsolete-session");

        clearLegacyBrowserAuthStorage();

        expect(window.localStorage.getItem("mike_auth_token")).toBe(
            "local-token",
        );
        expect(window.localStorage.getItem("sb-project-auth-token")).toBeNull();
        expect(window.sessionStorage.getItem("supabase.auth.session")).toBeNull();
    });
});
