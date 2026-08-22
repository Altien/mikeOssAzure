import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignupPage from "./page";

const { signUp, signInWithOAuth, replace, push } = vi.hoisted(() => ({
    signUp: vi.fn(),
    signInWithOAuth: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: { auth: { signUp, signInWithOAuth } },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: false, authLoading: false }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("SignupPage", () => {
    beforeEach(() => {
        signUp.mockReset();
        signInWithOAuth.mockReset();
        replace.mockReset();
        push.mockReset();
    });

    it("creates credentials and waits for email confirmation", async () => {
        signUp.mockResolvedValue({
            data: { session: null, user: { id: "user-1" } },
            error: null,
        });
        const user = userEvent.setup();
        render(<SignupPage />);

        expect(screen.getByLabelText("Password")).toHaveAttribute(
            "placeholder",
            "Min. 10 Characters",
        );

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "alex@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "secret1234");
        await user.type(
            screen.getByLabelText("Confirm Password"),
            "secret1234",
        );
        await user.click(screen.getByRole("button", { name: "Sign up" }));

        expect(signUp).toHaveBeenCalledWith({
            email: "alex@example.com",
            password: "secret1234",
            options: {
                emailRedirectTo:
                    "http://localhost:3000/auth/callback?next=%2Fonboarding%2Fprofile",
            },
        });
        expect(push).toHaveBeenCalledWith("/signup/check-email");
    });

    it("places Google signup after the primary signup action", () => {
        render(<SignupPage />);

        const signup = screen.getByRole("button", { name: "Sign up" });
        const google = screen.getByRole("button", {
            name: "Continue with Google",
        });
        expect(
            signup.compareDocumentPosition(google) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
});
