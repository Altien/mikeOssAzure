import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockPush } = vi.hoisted(() => ({
    mockPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        push: mockPush,
        replace: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
        prefetch: vi.fn(),
    }),
}));

vi.mock("@/app/lib/modelAvailability", () => ({
    providerLabel: (provider: string) => {
        const map: Record<string, string> = {
            claude: "Claude",
            openai: "OpenAI",
            gemini: "Gemini",
            azureOpenai: "Azure OpenAI",
        };
        return map[provider] ?? "Unknown";
    },
}));

import { ApiKeyMissingModal } from "./ApiKeyMissingModal";

beforeEach(() => {
    mockPush.mockReset();
});

describe("ApiKeyMissingModal", () => {
    it("renders nothing when open=false", () => {
        const { container } = render(
            <ApiKeyMissingModal
                open={false}
                onClose={() => {}}
                provider="claude"
            />,
        );

        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    });

    it("renders the modal heading + a provider-specific default body when open", () => {
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={() => {}}
                provider="claude"
            />,
        );

        // Promoted code renders via WarningPopup: the title is a styled
        // <div>, not a heading element, so match it by text.
        expect(screen.getByText("API key required")).toBeInTheDocument();
        expect(
            screen.getByText(
                /You haven't added a Claude API key yet\. Add one in your account settings to use this model\./,
            ),
        ).toBeInTheDocument();
    });

    it("falls back to 'this provider' when provider is null", () => {
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={() => {}}
                provider={null}
            />,
        );

        expect(
            screen.getByText(
                /You haven't added a this provider API key yet/,
            ),
        ).toBeInTheDocument();
    });

    it("renders the custom message override when supplied", () => {
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={() => {}}
                provider="openai"
                message="Custom override copy."
            />,
        );

        expect(screen.getByText("Custom override copy.")).toBeInTheDocument();
        // Provider name doesn't leak when the override is set.
        expect(screen.queryByText(/OpenAI API key yet/)).not.toBeInTheDocument();
    });

    it("Dismiss ('X') button invokes onClose", async () => {
        // Promoted code dropped the explicit "Cancel" button; the dismiss
        // affordance is now the WarningPopup "Dismiss warning" (X) button,
        // which still calls onClose.
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="claude"
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Dismiss warning" }),
        );

        expect(onClose).toHaveBeenCalledOnce();
    });

    it("'Go to account settings' invokes onClose AND routes to /account/models", async () => {
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="claude"
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Go to account settings" }),
        );

        expect(onClose).toHaveBeenCalledOnce();
        expect(mockPush).toHaveBeenCalledWith("/account/models");
    });

    // NOTE: The promoted code replaced the centered modal+backdrop with a
    // top-anchored WarningPopup toast that has no click-to-dismiss backdrop,
    // so the former "clicking the backdrop closes the modal" test no longer
    // describes any real behavior and has been removed.

    it("clicking the popup title or body does NOT close it", async () => {
        // Important UX: clicking the body text or the title must not
        // dismiss the popup — only the explicit Dismiss / action buttons do.
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="openai"
            />,
        );

        await userEvent.click(screen.getByText("API key required"));
        await userEvent.click(
            screen.getByText(/You haven't added a OpenAI API key/),
        );

        expect(onClose).not.toHaveBeenCalled();
    });
});
