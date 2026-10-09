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

// OSS-6: dev's shared/ApiKeyMissingModal became upstream's popups/ApiKeyMissingPopup
// (dev's organisation-credential copy re-applied there).
import { ApiKeyMissingPopup } from "./ApiKeyMissingPopup";

beforeEach(() => {
    mockPush.mockReset();
});

describe("ApiKeyMissingPopup", () => {
    it("renders nothing when open=false", () => {
        const { container } = render(
            <ApiKeyMissingPopup
                open={false}
                onClose={() => {}}
            />,
        );

        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    });

    it("tells the user that an administrator must configure the organisation key", () => {
        render(
            <ApiKeyMissingPopup
                open={true}
                onClose={() => {}}
            />,
        );

        expect(screen.getByText("API key required")).toBeInTheDocument();
        expect(
            screen.getByText(
                /No models are configured for this organisation.*administrator.*organisation credential/i,
            ),
        ).toBeInTheDocument();
    });

    it("uses provider-agnostic copy", () => {
        render(
            <ApiKeyMissingPopup
                open={true}
                onClose={() => {}}
            />,
        );

        expect(
            screen.getByText(
                /No models are configured for this organisation/i,
            ),
        ).toBeInTheDocument();
    });

    it("renders the custom message override when supplied", () => {
        render(
            <ApiKeyMissingPopup
                open={true}
                onClose={() => {}}
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
            <ApiKeyMissingPopup
                open={true}
                onClose={onClose}
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
            <ApiKeyMissingPopup
                open={true}
                onClose={onClose}
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
            <ApiKeyMissingPopup
                open={true}
                onClose={onClose}
            />,
        );

        await userEvent.click(screen.getByText("API key required"));
        await userEvent.click(
            screen.getByText(/No models are configured for this organisation/),
        );

        expect(onClose).not.toHaveBeenCalled();
    });
});
