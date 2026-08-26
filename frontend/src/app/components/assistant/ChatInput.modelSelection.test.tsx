import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: vi.fn(),
}));

vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));

// The real module is kept for its constants — useSelectedModel imports
// ALLOWED_MODEL_IDS/DEFAULT_MODEL_ID/canonicalModelId from it, and this test
// exercises the real hook.
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));

vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

const STORED = "openrouter/pricy/frontier";

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

function emptyApiKeys() {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        vercel: { configured: false, source: null },
        courtlistener: { configured: false, source: null },
    };
}

function mockProfile(apiKeysDegraded: boolean) {
    vi.mocked(useUserProfile).mockReturnValue({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            lastUsedChatModel: "gpt-5.6-luna",
            apiKeys: emptyApiKeys(),
        },
        loading: false,
        apiKeysDegraded,
    } as unknown as ReturnType<typeof useUserProfile>);
}

describe("ChatInput model selection vs. a degraded profile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    it("keeps the chat model when router availability is unknown", async () => {
        mockProfile(true);
        const onSubmit = vi.fn();

        render(
            <ChatInput
                chatModel={STORED}
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "hello" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({ model: STORED }),
            ),
        );
    });

    it("falls back to profile last-used when the chat router model is stale", async () => {
        mockProfile(false);
        const onSubmit = vi.fn();

        render(
            <ChatInput
                chatModel={STORED}
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "hello" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({ model: "gpt-5.6-luna" }),
            ),
        );
    });
});
