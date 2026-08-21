import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingPracticePage from "./page";

const { push, replace, completeOnboarding } = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    completeOnboarding: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1", email: "alex@example.com" },
        authLoading: false,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            jurisdiction: null,
            practiceAreas: [],
        },
        loading: false,
        completeOnboarding,
    }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("OnboardingPracticePage", () => {
    beforeEach(() => {
        push.mockReset();
        replace.mockReset();
        completeOnboarding.mockReset();
        completeOnboarding.mockResolvedValue(true);
    });

    it("saves a country and multiple practice areas", async () => {
        const user = userEvent.setup();
        render(<OnboardingPracticePage />);

        await user.selectOptions(
            screen.getByLabelText("Jurisdiction of practice"),
            "Singapore",
        );
        await user.click(
            screen.getByRole("button", { name: "Select practice areas" }),
        );
        await user.click(
            screen.getByRole("menuitemcheckbox", { name: "Litigation" }),
        );
        await user.click(
            screen.getByRole("menuitemcheckbox", {
                name: "Data Protection and Privacy",
            }),
        );
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Finish" }));

        await waitFor(() =>
            expect(completeOnboarding).toHaveBeenCalledWith("Singapore", [
                "Litigation",
                "Data Protection and Privacy",
            ]),
        );
        expect(replace).toHaveBeenCalledWith("/assistant");
    });

    it("requires free text when Other is selected", async () => {
        const user = userEvent.setup();
        render(<OnboardingPracticePage />);

        await user.selectOptions(
            screen.getByLabelText("Jurisdiction of practice"),
            "Australia",
        );
        await user.click(
            screen.getByRole("button", { name: "Select practice areas" }),
        );
        await user.click(
            screen.getByRole("menuitemcheckbox", { name: "Other" }),
        );
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Finish" }));

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Enter your other practice area",
        );
        expect(completeOnboarding).not.toHaveBeenCalled();
    });
});
