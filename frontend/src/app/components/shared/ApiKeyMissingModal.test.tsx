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

    it("tells the user that an administrator must configure the organisation key", () => {
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={() => {}}
                provider="claude"
            />,
        );

        expect(screen.getByText("API key required")).toBeInTheDocument();
        expect(
            screen.getByText(
                /Claude is not configured for this organisation.*administrator.*\/install/i,
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
                /this provider is not configured for this organisation/i,
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

    it("the dismiss button invokes onClose", async () => {
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

    it("'Open organisation setup' invokes onClose AND routes to /install", async () => {
        const onClose = vi.fn();
        render(
            <ApiKeyMissingModal
                open={true}
                onClose={onClose}
                provider="claude"
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Open organisation setup" }),
        );

        expect(onClose).toHaveBeenCalledOnce();
        expect(mockPush).toHaveBeenCalledWith("/install");
    });

    it("clicking the popup body does NOT dismiss it — only the X or the actions do", async () => {
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
            screen.getByText(/OpenAI is not configured for this organisation/),
        );

        expect(onClose).not.toHaveBeenCalled();
    });
});
