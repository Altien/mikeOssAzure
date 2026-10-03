import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "./page";

const { resetPasswordForEmail, runtime } = vi.hoisted(() => ({
    resetPasswordForEmail: vi.fn(),
    runtime: { authProvider: "supabase", loading: false },
}));

vi.mock("@/app/lib/supabase", () => ({
    getSupabaseClient: () => ({ auth: { resetPasswordForEmail } }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("ForgotPasswordPage", () => {
    beforeEach(() => {
        resetPasswordForEmail.mockReset();
        runtime.authProvider = "supabase";
        runtime.loading = false;
    });

    it.each(["entra", "local"])("keeps recovery with the %s provider", (provider) => {
        runtime.authProvider = provider;
        render(<ForgotPasswordPage />);
        expect(screen.getByRole("link", { name: "Return to login" })).toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
        expect(resetPasswordForEmail).not.toHaveBeenCalled();
    });

    it("waits for runtime configuration before mounting recovery", () => {
        runtime.loading = true;
        render(<ForgotPasswordPage />);
        expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
        expect(resetPasswordForEmail).not.toHaveBeenCalled();
    });

    it("sends recovery through the shared callback", async () => {
        resetPasswordForEmail.mockResolvedValue({ error: null });
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(resetPasswordForEmail).toHaveBeenCalledWith(
            "person@example.com",
            {
                redirectTo:
                    "http://localhost:3000/auth/callback?next=%2Freset-password",
            },
        );
        expect(
            await screen.findByRole("heading", { name: "Check your email" }),
        ).toBeInTheDocument();
    });

    it("uses the same response when the request fails", async () => {
        resetPasswordForEmail.mockRejectedValue(new Error("not found"));
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "unknown@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(
            await screen.findByRole("heading", { name: "Check your email" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/If an account exists/)).toBeInTheDocument();
    });
});

vi.mock("@/app/contexts/ConfigContext", () => ({ useConfig: () => runtime, useConfigLoading: () => runtime.loading }));
