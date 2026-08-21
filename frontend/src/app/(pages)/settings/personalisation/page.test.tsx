import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PersonalisationPage from "./page";

const { updatePersonalisation } = vi.hoisted(() => ({
    updatePersonalisation: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            jurisdiction: "Singapore",
            practiceSetting: "private_practice",
            professionalTitle: "Associate",
            practiceAreas: ["Litigation"],
        },
        updatePersonalisation,
    }),
}));

describe("PersonalisationPage", () => {
    beforeEach(() => {
        updatePersonalisation.mockReset();
        updatePersonalisation.mockResolvedValue(true);
    });

    it("updates the user's professional profile", async () => {
        const user = userEvent.setup();
        render(<PersonalisationPage />);

        await user.click(screen.getByRole("button", { name: "Title" }));
        await user.click(
            screen.getByRole("menuitemradio", { name: "General Counsel" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Professional setting" }),
        );
        await user.click(
            screen.getByRole("menuitemradio", { name: "In-house" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Jurisdiction of practice" }),
        );
        await user.click(
            screen.getByRole("menuitemradio", { name: "Australia" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Practice areas" }),
        );
        await user.click(
            screen.getByRole("menuitemcheckbox", {
                name: "Data Protection and Privacy",
            }),
        );
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(updatePersonalisation).toHaveBeenCalledWith({
                jurisdiction: "Australia",
                practiceSetting: "in_house",
                professionalTitle: "General Counsel",
                practiceAreas: ["Litigation", "Data Protection and Privacy"],
            }),
        );
        expect(screen.getByText("Practice areas").parentElement).toHaveTextContent(
            "Saved",
        );
        expect(screen.queryByText("(optional)")).not.toBeInTheDocument();
    });
});
