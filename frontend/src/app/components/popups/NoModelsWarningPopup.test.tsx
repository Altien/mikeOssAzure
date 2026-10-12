import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoModelsWarningPopup } from "./NoModelsWarningPopup";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    activeOrganization: null as { id: string; name: string } | null,
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ activeOrganization: mocks.activeOrganization }),
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeOrganization = null;
});

describe("NoModelsWarningPopup", () => {
    it("asks to turn a provider back on when every saved key is switched off", () => {
        render(
            <NoModelsWarningPopup
                reason="providers-disabled"
                onClose={vi.fn()}
            />,
        );

        expect(
            screen.getByText(
                "Your saved API keys are all turned off. Turn a provider back on in Bring Your Own Keys to select a model.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/Add an API key/),
        ).not.toBeInTheDocument();
    });

    it("sends the caller to their own keys for a personal cause", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<NoModelsWarningPopup reason="api-keys" onClose={onClose} />);

        await user.click(
            screen.getByRole("button", { name: "Open Bring Your Own Keys" }),
        );

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/settings/byok");
    });

    describe("in an organization workspace", () => {
        beforeEach(() => {
            mocks.activeOrganization = { id: "org-1", name: "Acme LLP" };
        });

        it.each([
            [
                "org-router-models",
                "Your organization has not added any models for its provider yet. Ask an organization admin to add them under Model Providers.",
            ],
            [
                "org-providers-disabled",
                "Your organization has turned its model providers off. Ask an organization admin to turn one back on under Model Providers.",
            ],
            [
                "org-api-keys",
                "Your organization has not set up a model provider yet. Ask an organization admin to add one under Model Providers.",
            ],
        ] as const)(
            "says who can fix %s and opens the organization's providers",
            async (reason, message) => {
                const user = userEvent.setup();
                const onClose = vi.fn();
                render(<NoModelsWarningPopup reason={reason} onClose={onClose} />);

                expect(screen.getByText(message)).toBeInTheDocument();
                // Not a trip to personal settings, where a member cannot fix it.
                expect(
                    screen.queryByRole("button", {
                        name: "Open Bring Your Own Keys",
                    }),
                ).not.toBeInTheDocument();

                await user.click(
                    screen.getByRole("button", { name: "Open Model Providers" }),
                );

                expect(onClose).toHaveBeenCalledTimes(1);
                expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
                    "/organizations/org-1?tab=providers",
                );
            },
        );

        it("offers the member's own keys when the organization allows them in its place", async () => {
            const user = userEvent.setup();
            render(
                <NoModelsWarningPopup
                    reason="org-api-keys-or-own"
                    onClose={vi.fn()}
                />,
            );

            expect(
                screen.getByText(
                    "Your organization has not set up a model provider yet. Ask an organization admin to add one under Model Providers, or add your own API key in Bring Your Own Keys.",
                ),
            ).toBeInTheDocument();
            // The step the member can take themselves.
            await user.click(
                screen.getByRole("button", { name: "Open Bring Your Own Keys" }),
            );
            expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/settings/byok");
        });

        it("still sends a personal cause to the caller's own keys", () => {
            render(
                <NoModelsWarningPopup reason="router-models" onClose={vi.fn()} />,
            );
            expect(
                screen.getByRole("button", { name: "Open Bring Your Own Keys" }),
            ).toBeInTheDocument();
        });
    });
});
