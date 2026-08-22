import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthButton } from "./GoogleAuthButton";

const { signInWithOAuth } = vi.hoisted(() => ({
    signInWithOAuth: vi.fn(),
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: { auth: { signInWithOAuth } },
}));

describe("GoogleAuthButton", () => {
    beforeEach(() => {
        signInWithOAuth.mockReset();
    });

    it("starts Google OAuth with the shared auth callback", async () => {
        signInWithOAuth.mockResolvedValue({ error: null });
        const onError = vi.fn();
        const user = userEvent.setup();
        render(<GoogleAuthButton onError={onError} />);

        await user.click(
            screen.getByRole("button", { name: "Continue with Google" }),
        );

        expect(signInWithOAuth).toHaveBeenCalledWith({
            provider: "google",
            options: {
                redirectTo:
                    "http://localhost:3000/auth/callback?next=%2Fonboarding%2Fprofile",
            },
        });
        expect(onError).toHaveBeenCalledWith("");
        expect(
            screen.getByRole("button", { name: "Continuing…" }),
        ).toBeDisabled();
    });

    it("surfaces provider startup errors and re-enables the button", async () => {
        signInWithOAuth.mockResolvedValue({
            error: new Error("Google provider is unavailable"),
        });
        const onError = vi.fn();
        const user = userEvent.setup();
        render(<GoogleAuthButton onError={onError} />);

        await user.click(
            screen.getByRole("button", { name: "Continue with Google" }),
        );

        expect(onError).toHaveBeenLastCalledWith(
            "Google provider is unavailable",
        );
        expect(
            screen.getByRole("button", { name: "Continue with Google" }),
        ).toBeEnabled();
    });
});
