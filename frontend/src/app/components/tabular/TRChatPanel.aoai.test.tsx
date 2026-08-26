import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { streamTabularChatMock } = vi.hoisted(() => ({
    streamTabularChatMock: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    streamTabularChat: streamTabularChatMock,
    getTabularChats: vi.fn(async () => []),
    getTabularChatMessages: vi.fn(async () => []),
    deleteTabularChat: vi.fn(async () => undefined),
    renameTabularChat: vi.fn(async () => undefined),
    mapTRMessages: vi.fn((messages) => messages),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            tabularModel: "aoai:removed-deployment",
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: false, source: null },
                openai: { configured: false, source: null },
                openrouter: { configured: false, source: null },
                courtlistener: { configured: false, source: null },
                kimi: { configured: false, source: null },
                azure_openai: { configured: true, source: "env" },
            },
        },
        updateModelPreference: vi.fn(),
    }),
}));

vi.mock("@/altien/models/aoaiDeployments", () => ({
    useAoaiDeployments: () => ({
        modelOptions: [
            {
                id: "aoai:current-deployment",
                label: "Current",
                group: "Azure OpenAI",
            },
        ],
    }),
}));

vi.mock("../assistant/ModelToggle", () => ({
    ModelToggle: () => <div data-testid="model-toggle" />,
}));

vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: ({ open }: { open: boolean }) =>
        open ? <div>Model unavailable</div> : null,
}));

import { TRChatPanel } from "./TRChatPanel";

beforeAll(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
});

describe("TRChatPanel Azure OpenAI deployment validation", () => {
    it("blocks a saved deployment that is no longer discovered", async () => {
        render(
            <TRChatPanel
                reviewId="review-1"
                model="aoai:stale-deployment"
                onModelChange={vi.fn()}
                onCitationClick={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const input = screen.getByPlaceholderText("How can I help?");
        fireEvent.change(input, { target: { value: "Summarise this review" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(
            await screen.findByText("Model unavailable"),
        ).toBeInTheDocument();
        await waitFor(() =>
            expect(streamTabularChatMock).not.toHaveBeenCalled(),
        );
    });
});
