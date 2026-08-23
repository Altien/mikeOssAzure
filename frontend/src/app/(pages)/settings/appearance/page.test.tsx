import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppearancePage from "./page";

const { updateDarkMode, profile } = vi.hoisted(() => ({
    updateDarkMode: vi.fn(),
    profile: { darkMode: false },
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile, updateDarkMode }),
}));

describe("AppearancePage", () => {
    beforeEach(() => {
        updateDarkMode.mockReset();
        updateDarkMode.mockResolvedValue(undefined);
        profile.darkMode = false;
    });

    it("saves dark mode without rendering a decorative card icon", async () => {
        const user = userEvent.setup();
        const { container } = render(<AppearancePage />);

        expect(
            screen.getByRole("heading", { name: "Appearance" }),
        ).toBeVisible();
        expect(screen.getByText("Dark mode")).toBeVisible();
        expect(container.querySelector("svg")).toBeNull();

        const toggle = screen.getByRole("switch");
        expect(toggle).toHaveAttribute("aria-checked", "false");

        await user.click(toggle);
        expect(updateDarkMode).toHaveBeenCalledWith(true);
    });

    it("reports a failed change without leaking the raw error", async () => {
        const user = userEvent.setup();
        updateDarkMode.mockRejectedValue(new Error("pg: connection refused"));
        render(<AppearancePage />);

        await user.click(screen.getByRole("switch"));
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Could not update the appearance setting.",
            ),
        );
        expect(screen.queryByText(/connection refused/i)).not.toBeInTheDocument();
    });
});
