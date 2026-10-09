import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const {
    login,
    loginLocal,
    config,
    signup,
    startGoogleOAuth,
    refreshSession,
    replace,
    push,
    getUserProfile,
    completeUserOnboarding,
} = vi.hoisted(() => ({
    login: vi.fn(),
    loginLocal: vi.fn(),
    config: { authProvider: "supabase" },
    signup: vi.fn(),
    startGoogleOAuth: vi.fn(),
    refreshSession: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
    getUserProfile: vi.fn(),
    completeUserOnboarding: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
}));

vi.mock("@/app/lib/authApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/authApi")>()),
    login,
    loginLocal,
    signup,
    startGoogleOAuth,
}));

vi.mock("@/app/contexts/ConfigContext", () => ({ useConfig: () => config }));

vi.mock("@/app/lib/mikeApi", () => ({
    getUserProfile,
    completeUserOnboarding,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        isAuthenticated: false,
        authLoading: false,
        refreshSession,
    }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("LoginPage", () => {
    beforeEach(() => {
        login.mockReset();
        loginLocal.mockReset().mockResolvedValue({ user: { id: "local" } });
        config.authProvider = "supabase";
        signup.mockReset();
        startGoogleOAuth.mockReset();
        delete (window as { mikeDesktop?: unknown }).mikeDesktop;
        refreshSession.mockReset();
        refreshSession.mockResolvedValue(null);
        replace.mockReset();
        push.mockReset();
        getUserProfile
            .mockReset()
            .mockResolvedValue({ onboardingComplete: true });
        completeUserOnboarding
            .mockReset()
            .mockResolvedValue({ onboardingComplete: true });
    });

    it("allows an existing account to submit a password shorter than the new minimum", async () => {
        login.mockResolvedValue({ user: { id: "user-1" } });
        const user = userEvent.setup();
        render(<LoginPage />);

        expect(screen.getByLabelText("Password")).not.toHaveAttribute(
            "placeholder",
        );

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "existing@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "oldpass");
        await user.click(screen.getByRole("button", { name: "Log in" }));

        expect(login).toHaveBeenCalledWith("existing@example.com", "oldpass");
        expect(push).toHaveBeenCalledWith("/onboarding/profile");
    });

    it("places Google and SSO after the primary login action", () => {
        render(<LoginPage />);

        const login = screen.getByRole("button", { name: "Log in" });
        const google = screen.getByRole("button", {
            name: "Continue with Google",
        });
        const sso = screen.getByRole("button", { name: "Continue with SSO" });
        expect(
            login.compareDocumentPosition(google) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            google.compareDocumentPosition(sso) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
    it("hides the guest button outside the Mac desktop shell", async () => {
        // window.mikeDesktop only exists inside the Electron shell, and only
        // its local ("everything on this Mac") mode answers with credentials.
        // In a browser and against Mike Cloud this page must be unchanged.
        render(<LoginPage />);
        expect(
            screen.queryByRole("button", { name: "Continue on this Mac" }),
        ).toBeNull();
    });

    it("opens a returning guest through Dev local sessions", async () => {
        config.authProvider = "local";
        window.mikeDesktop = { guestCredentials: async () => ({ email: "guest@mike.local" }) };
        render(<LoginPage />);
        await userEvent.click(await screen.findByRole("button", { name: "Continue on this Mac" }));
        expect(loginLocal).toHaveBeenCalledWith("guest@mike.local");
        expect(login).not.toHaveBeenCalled();
        expect(signup).not.toHaveBeenCalled();
        expect(refreshSession).toHaveBeenCalled();
        expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("completes a new local guest profile without a cloud signup", async () => {
        config.authProvider = "local";
        window.mikeDesktop = { guestCredentials: async () => ({ email: "guest@mike.local" }) };
        getUserProfile.mockResolvedValue({ onboardingComplete: false });
        render(<LoginPage />);
        await userEvent.click(await screen.findByRole("button", { name: "Continue on this Mac" }));
        expect(completeUserOnboarding).toHaveBeenCalledWith();
        expect(signup).not.toHaveBeenCalled();
        expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("does not register an account after a network failure", async () => {
        config.authProvider = "local";
        window.mikeDesktop = {
            guestCredentials: async () => ({
                email: "guest@mike.local",
                password: "secret",
            }),
        };
        loginLocal.mockRejectedValue(new TypeError("Failed to fetch"));
        render(<LoginPage />);
        await userEvent.click(
            await screen.findByRole("button", { name: "Continue on this Mac" }),
        );
        expect(signup).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Unable to open the local workspace",
        );
    });
});
