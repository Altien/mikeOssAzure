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

        expect(
            screen.getByRole("heading", { name: "API key required" }),
        ).toBeInTheDocument();
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

    it("Cancel button invokes onClose", async () => {
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="claude"
            />,
        );

        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

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

    it("clicking the backdrop closes the modal", async () => {
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="claude"
            />,
        );

        // The backdrop wraps the dialog and has the onClick that fires
        // onClose; the inner card stops propagation.
        const backdrop = screen.getByRole("heading").closest(".fixed");
        expect(backdrop).not.toBeNull();
        await userEvent.click(backdrop!);

        expect(onClose).toHaveBeenCalledOnce();
    });

    it("clicking inside the dialog card does NOT close the modal", async () => {
        // Important UX: clicking the body text or the heading must
        // not dismiss the modal — only the backdrop or explicit
        // buttons do.
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="openai"
            />,
        );

        await userEvent.click(
            screen.getByRole("heading", { name: "API key required" }),
        );
        await userEvent.click(
            screen.getByText(/You haven't added a OpenAI API key/),
        );

        expect(onClose).not.toHaveBeenCalled();
    });
});
