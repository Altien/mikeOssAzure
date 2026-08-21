import { afterEach, describe, expect, it, vi } from "vitest";
import {
    authCallbackUrl,
    authErrorDescription,
    browserAuthCallbackUrl,
    safeAuthNext,
} from "./authRedirects";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("safeAuthNext", () => {
    it("allows known internal destinations with query parameters", () => {
        expect(safeAuthNext("/settings?emailChange=processed")).toBe(
            "/settings?emailChange=processed",
        );
        expect(safeAuthNext("/reset-password")).toBe("/reset-password");
        expect(safeAuthNext("/onboarding/profile")).toBe("/onboarding/profile");
    });

    it.each([
        "assistant",
        "https://evil.example",
        "//evil.example/path",
        "/unknown",
        "/settings\\evil",
        "/settings\n/assistant",
    ])("rejects unsafe destination %s", (candidate) => {
        expect(safeAuthNext(candidate)).toBe("/assistant");
    });

    it("uses a caller-provided fallback when no destination is supplied", () => {
        expect(safeAuthNext(undefined, "/login")).toBe("/login");
    });
});

describe("authCallbackUrl", () => {
    it("builds an origin-bound callback with an encoded safe destination", () => {
        expect(
            authCallbackUrl(
                "https://app.example.com",
                "/settings?emailChange=processed",
            ),
        ).toBe(
            "https://app.example.com/auth/callback?next=%2Fsettings%3FemailChange%3Dprocessed",
        );
    });

    it("builds callbacks from the browser origin", () => {
        expect(browserAuthCallbackUrl("/reset-password")).toBe(
            "http://localhost:3000/auth/callback?next=%2Freset-password",
        );
    });

    it("does not build a browser callback during server rendering", () => {
        vi.stubGlobal("window", undefined);

        expect(browserAuthCallbackUrl("/reset-password")).toBeUndefined();
    });
});

describe("authErrorDescription", () => {
    it("reads provider errors from query parameters or implicit-flow hashes", () => {
        expect(
            authErrorDescription("?error_description=Expired+link", ""),
        ).toBe("This confirmation link is invalid or has expired.");
        expect(
            authErrorDescription("", "#error=access_denied"),
        ).toBe("Authentication was cancelled or denied.");
        expect(authErrorDescription("?error=query_error", "")).toBe(
            "Authentication could not be completed. Please try again.",
        );
        expect(
            authErrorDescription("", "#error_description=Invalid+request"),
        ).toBe("This confirmation link is invalid or has expired.");
        expect(authErrorDescription("", "")).toBeNull();
    });
});
