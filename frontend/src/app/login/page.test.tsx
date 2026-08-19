import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const { signInWithPassword, replace, push } = vi.hoisted(() => ({
    signInWithPassword: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: { auth: { signInWithPassword } },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: false, authLoading: false }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("LoginPage", () => {
    beforeEach(() => {
        signInWithPassword.mockReset();
        replace.mockReset();
        push.mockReset();
    });

    it("allows an existing account to submit a password shorter than the new minimum", async () => {
        signInWithPassword.mockResolvedValue({ error: null });
        const user = userEvent.setup();
        render(<LoginPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "existing@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "oldpass");
        await user.click(screen.getByRole("button", { name: "Log in" }));

        expect(signInWithPassword).toHaveBeenCalledWith({
            email: "existing@example.com",
            password: "oldpass",
        });
        expect(push).toHaveBeenCalledWith("/assistant");
    });
});
