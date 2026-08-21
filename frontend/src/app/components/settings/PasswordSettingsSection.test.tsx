import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordSettingsSection } from "./PasswordSettingsSection";

const state = vi.hoisted(() => ({
    user: {
        id: "user-1",
        email: "alex@example.com",
        pendingEmail: null,
        createdWithGoogle: true,
        hasPassword: false,
    },
    setPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: state.user, setPassword: state.setPassword }),
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: {
        auth: { resetPasswordForEmail: state.resetPasswordForEmail },
    },
}));

describe("PasswordSettingsSection", () => {
    beforeEach(() => {
        state.user.createdWithGoogle = true;
        state.user.hasPassword = false;
        state.setPassword.mockReset();
        state.setPassword.mockResolvedValue(undefined);
        state.resetPasswordForEmail.mockReset();
        state.resetPasswordForEmail.mockResolvedValue({ error: null });
    });

    it("lets a Google-created account add its first password", async () => {
        const user = userEvent.setup();
        render(<PasswordSettingsSection />);

        expect(screen.getByText("Set password", { selector: "p" })).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Set password" }),
        );

        const dialog = screen.getByRole("dialog", { name: "Set password" });
        await waitFor(() =>
            expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus(),
        );
        await user.type(
            within(dialog).getByLabelText("Password"),
            "securepass1",
        );
        await user.type(
            within(dialog).getByLabelText("Confirm password"),
            "securepass1",
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Set password" }),
        );

        await waitFor(() =>
            expect(state.setPassword).toHaveBeenCalledWith("securepass1"),
        );
        expect(screen.getByText("Password added to your account.")).toBeVisible();
    });

    it("keeps the reset-email flow for accounts that already have a password", async () => {
        state.user.hasPassword = true;
        const user = userEvent.setup();
        render(<PasswordSettingsSection />);

        expect(screen.getByText("Reset password")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Send reset email" }),
        );

        await waitFor(() =>
            expect(state.resetPasswordForEmail).toHaveBeenCalledWith(
                "alex@example.com",
                expect.objectContaining({
                    redirectTo: expect.stringContaining("reset-password"),
                }),
            ),
        );
    });
});
