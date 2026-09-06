import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getAuthToken,
    getCurrentUser,
    localAuth,
    resolveBrowserAuthProvider,
    setPassword,
    signInWithPassword,
    signOut,
    signUpWithPassword,
    updateEmail,
} from "./auth";

const fetchMock = vi.fn();
const user = {
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

describe("SQLite browser auth", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        window.localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("always selects local auth and rejects removed providers", () => {
        expect(resolveBrowserAuthProvider({})).toBe("local");
        expect(
            resolveBrowserAuthProvider({
                NEXT_PUBLIC_MIKE_AUTH_PROVIDER: "LOCAL",
            }),
        ).toBe("local");
        expect(() =>
            resolveBrowserAuthProvider({
                NEXT_PUBLIC_MIKE_AUTH_PROVIDER: "supabase",
            }),
        ).toThrow(/This fork uses local SQLite authentication/);
    });

    it("signs in, stores the token, and notifies listeners", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ token: "local-token", user }),
        );
        const dispatch = vi.spyOn(window, "dispatchEvent");

        await expect(
            signInWithPassword(user.email, "password"),
        ).resolves.toEqual({ token: "local-token", user });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/login",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    email: user.email,
                    password: "password",
                }),
            }),
        );
        expect(window.localStorage.getItem("mike_auth_token")).toBe(
            "local-token",
        );
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ type: "mike-auth-change" }),
        );
    });

    it("signs up through the local account endpoint", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ token: "signup-token", user }),
        );

        await expect(
            signUpWithPassword(user.email, "password"),
        ).resolves.toEqual({ token: "signup-token", user });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/signup",
            expect.objectContaining({ method: "POST" }),
        );
    });

    it("returns no current user without a stored token", async () => {
        await expect(getCurrentUser()).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("loads the current user with the bearer token", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        fetchMock.mockResolvedValue(jsonResponse({ user }));

        await expect(getCurrentUser()).resolves.toEqual(user);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/session",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer local-token",
                }),
            }),
        );
    });

    it("clears an invalid local session", async () => {
        window.localStorage.setItem("mike_auth_token", "expired-token");
        fetchMock.mockResolvedValue(
            jsonResponse({ detail: "Invalid or expired token" }, 401),
        );

        await expect(getCurrentUser()).resolves.toBeNull();
        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();
    });

    it("logs out and clears the local token even if the backend is unavailable", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        fetchMock.mockRejectedValue(new Error("offline"));

        await expect(signOut()).resolves.toBeUndefined();
        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();
    });

    it("updates the local account email", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        const updated = { ...user, email: "new@example.test" };
        fetchMock.mockResolvedValue(jsonResponse({ user: updated }));

        await expect(updateEmail(updated.email)).resolves.toEqual(updated);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/user/auth/email",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({ email: updated.email }),
            }),
        );
    });

    it("returns the stored bearer token", async () => {
        await expect(getAuthToken()).resolves.toBeNull();
        window.localStorage.setItem("mike_auth_token", "local-token");
        await expect(getAuthToken()).resolves.toBe("local-token");
    });

    it("rejects the federated-account password operation", async () => {
        await expect(setPassword("new-password")).rejects.toThrow(
            /not supported by SQLite authentication/,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lists verified local TOTP factors", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        const factor = {
            id: "factor-1",
            factor_type: "totp",
            status: "verified",
        };
        fetchMock.mockResolvedValue(
            jsonResponse({
                factors: [factor],
                currentLevel: "aal2",
                nextLevel: "aal2",
            }),
        );

        await expect(localAuth.mfa.listFactors()).resolves.toEqual({
            data: { all: [factor], totp: [factor] },
            error: null,
        });
    });

    it("enrolls and verifies a local TOTP factor", async () => {
        window.localStorage.setItem("mike_auth_token", "local-token");
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({
                    id: "factor-1",
                    totp: { qr_code: "qr", secret: "secret" },
                }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(
            localAuth.mfa.enroll({ friendlyName: "Authenticator" }),
        ).resolves.toEqual({
            data: {
                id: "factor-1",
                totp: { qr_code: "qr", secret: "secret" },
            },
            error: null,
        });
        await expect(
            localAuth.mfa.verify({
                factorId: "factor-1",
                challengeId: "challenge-1",
                code: "123456",
            }),
        ).resolves.toEqual({ data: null, error: null });

        expect(fetchMock.mock.calls[0][0]).toBe(
            "/api/user/mfa/enroll",
        );
        expect(fetchMock.mock.calls[1][0]).toBe(
            "/api/user/mfa/verify",
        );
    });
});
