import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignupPage from "./page";

const { signUp, replace, push } = vi.hoisted(() => ({
    signUp: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: { auth: { signUp } },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: false, authLoading: false }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    updateUserProfile: vi.fn(),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("SignupPage", () => {
    beforeEach(() => {
        signUp.mockReset();
        replace.mockReset();
        push.mockReset();
    });

    it("rejects a whitespace-only name", () => {
        render(<SignupPage />);

        fireEvent.change(screen.getByLabelText("Name"), {
            target: { value: "   " },
        });
        fireEvent.submit(
            screen.getByRole("button", { name: "Sign up" }).closest("form")!,
        );

        expect(screen.getByText("Name is required")).toBeInTheDocument();
        expect(signUp).not.toHaveBeenCalled();
    });

    it("stores profile metadata and waits for email confirmation", async () => {
        signUp.mockResolvedValue({
            data: { session: null, user: { id: "user-1" } },
            error: null,
        });
        const user = userEvent.setup();
        render(<SignupPage />);

        await user.type(screen.getByLabelText(/Name/), "  Alex  ");
        await user.type(
            screen.getByLabelText(/Organisation/),
            "  Example LLP  ",
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
                    "http://localhost:3000/auth/callback?next=%2Fassistant%3Fconfirmed%3D1",
                data: {
                    display_name: "Alex",
                    organisation: "Example LLP",
                },
            },
        });
        expect(push).toHaveBeenCalledWith("/signup/check-email");
    });
});
