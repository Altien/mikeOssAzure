import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppearancePage from "./page";

const { updateDarkMode, updateTransparentTables, profile } = vi.hoisted(() => ({
    updateDarkMode: vi.fn(),
    updateTransparentTables: vi.fn(),
    profile: { darkMode: false, transparentTables: true },
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile,
        updateDarkMode,
        updateTransparentTables,
    }),
}));

describe("AppearancePage", () => {
    beforeEach(() => {
        updateDarkMode.mockReset();
        updateDarkMode.mockResolvedValue(undefined);
        updateTransparentTables.mockReset();
        updateTransparentTables.mockResolvedValue(undefined);
        profile.darkMode = false;
        profile.transparentTables = true;
    });

    it("saves dark mode without rendering a decorative card icon", async () => {
        const user = userEvent.setup();
        const { container } = render(<AppearancePage />);

        expect(
            screen.getByRole("heading", { name: "Appearance" }),
        ).toBeVisible();
        expect(screen.getByText("Dark mode")).toBeVisible();
        expect(container.querySelector("svg")).toBeNull();

        const toggle = screen.getByRole("switch", { name: "Dark mode" });
        expect(toggle).toHaveAttribute("aria-checked", "false");

        await user.click(toggle);
        expect(updateDarkMode).toHaveBeenCalledWith(true);
    });

    it("reports a failed change without leaking the raw error", async () => {
        const user = userEvent.setup();
        updateDarkMode.mockRejectedValue(new Error("pg: connection refused"));
        render(<AppearancePage />);

        await user.click(screen.getByRole("switch", { name: "Dark mode" }));
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Could not update the appearance setting.",
            ),
        );
        expect(screen.queryByText(/connection refused/i)).not.toBeInTheDocument();
    });

    it("enables liquid glass tables from the transparent default", async () => {
        const user = userEvent.setup();
        render(<AppearancePage />);

        expect(screen.getByText("Liquid glass tables")).toBeVisible();
        const toggle = screen.getByRole("switch", {
            name: "Liquid glass tables",
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");

        await user.click(toggle);

        expect(updateTransparentTables).toHaveBeenCalledWith(false);
    });

    it("returns to transparent tables when liquid glass is disabled", async () => {
        const user = userEvent.setup();
        profile.transparentTables = false;
        render(<AppearancePage />);

        const toggle = screen.getByRole("switch", {
            name: "Liquid glass tables",
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");

        await user.click(toggle);

        expect(updateTransparentTables).toHaveBeenCalledWith(true);
    });

    it("reports a failed transparent tables change safely", async () => {
        const user = userEvent.setup();
        updateTransparentTables.mockRejectedValue(
            new Error("database connection refused"),
        );
        render(<AppearancePage />);

        await user.click(
            screen.getByRole("switch", { name: "Liquid glass tables" }),
        );

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Could not update the table appearance setting.",
            ),
        );
        expect(screen.queryByText(/connection refused/i)).not.toBeInTheDocument();
    });
});
