import type { ReactNode } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    CourtListenerTokenModal,
    useCourtListenerConnector,
} from "./CourtListenerConnector";

const state = vi.hoisted(() => ({
    hasProfile: true,
    legalResearchUs: true,
    bulkData: false,
    source: null as "org" | "user" | null,
    updateApiKey: vi.fn(),
    updateLegalResearchUs: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: state.hasProfile
            ? {
                  legalResearchUs: state.legalResearchUs,
                  courtlistenerBulkData: state.bulkData,
                  apiKeys: {
                      courtlistener: {
                          configured: state.source !== null,
                          source: state.source,
                      },
                  },
              }
            : null,
        updateApiKey: state.updateApiKey,
        updateLegalResearchUs: state.updateLegalResearchUs,
    }),
}));

// The key field has its own tests; here it shows whether a personal token
// counts as saved, and hands its actions to the dialog.
vi.mock("./ApiKeyField", () => ({
    ApiKeyField: ({
        hasSavedKey,
        onSave,
        onRemove,
        render,
    }: {
        hasSavedKey: boolean;
        onSave: (value: string) => Promise<boolean>;
        onRemove: () => Promise<boolean>;
        render: (
            fields: ReactNode,
            saveAction: { label: string; onClick: () => Promise<void>; disabled: boolean },
            removeAction:
                | { label: string; onClick: () => Promise<void>; disabled: boolean }
                | undefined,
        ) => ReactNode;
    }) =>
        render(
            <div data-testid="courtlistener-key-state">
                {hasSavedKey ? "personal" : "none"}
            </div>,
            {
                label: "Save",
                onClick: async () => {
                    await onSave("new-token");
                },
                disabled: false,
            },
            hasSavedKey
                ? {
                      label: "Remove",
                      onClick: async () => {
                          await onRemove();
                      },
                      disabled: false,
                  }
                : undefined,
        ),
}));

beforeEach(() => {
    vi.clearAllMocks();
    state.hasProfile = true;
    state.legalResearchUs = true;
    state.bulkData = false;
    state.source = null;
    state.updateApiKey.mockResolvedValue(true);
    state.updateLegalResearchUs.mockResolvedValue(true);
});

describe("useCourtListenerConnector", () => {
    const installed = () =>
        renderHook(() => useCourtListenerConnector()).result.current.installed;

    it("is installed only with a saved token or the deployment's bulk data", () => {
        expect(installed()).toBe(false);
        state.source = "user";
        expect(installed()).toBe(true);
        state.source = "org";
        expect(installed()).toBe(true);
        state.source = null;
        state.bulkData = true;
        expect(installed()).toBe(true);
    });

    it("is loading until the profile arrives", () => {
        state.hasProfile = false;
        const { result } = renderHook(() => useCourtListenerConnector());
        expect(result.current).toMatchObject({ loading: true, installed: false });
    });

    it("saves the switch and reports a failure only through the notice", async () => {
        state.updateLegalResearchUs.mockResolvedValue(false);
        const { result } = renderHook(() => useCourtListenerConnector());
        await act(() => result.current.setEnabled(false));
        expect(state.updateLegalResearchUs).toHaveBeenCalledWith(false);
        expect(result.current.enabled).toBe(true);
    });
});

describe("CourtListenerTokenModal", () => {
    it("adds a token, turns the connector on and closes", async () => {
        state.legalResearchUs = false;
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<CourtListenerTokenModal open onClose={onClose} />);

        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent("none");
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(state.updateApiKey).toHaveBeenCalledWith("courtlistener", "new-token");
        expect(state.updateLegalResearchUs).toHaveBeenCalledWith(true);
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("stays open when the token is not saved", async () => {
        state.updateApiKey.mockResolvedValue(false);
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<CourtListenerTokenModal open onClose={onClose} />);

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(onClose).not.toHaveBeenCalled();
        expect(state.updateLegalResearchUs).not.toHaveBeenCalled();
    });

    it("deletes a personal token from Manage", async () => {
        state.source = "user";
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<CourtListenerTokenModal open onClose={onClose} />);

        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent("personal");
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(state.updateApiKey).toHaveBeenCalledWith("courtlistener", null);
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("has nothing to delete for an organization's token", () => {
        state.source = "org";
        render(<CourtListenerTokenModal open onClose={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    it("notes the deployment's bulk data only when it is in use", () => {
        const { unmount } = render(<CourtListenerTokenModal open onClose={vi.fn()} />);
        expect(screen.queryByText("Bulk data installed and in use")).toBeNull();
        unmount();
        state.bulkData = true;
        render(<CourtListenerTokenModal open onClose={vi.fn()} />);
        expect(screen.getByText("Bulk data installed and in use")).toBeTruthy();
    });

    it("renders nothing while closed", () => {
        render(<CourtListenerTokenModal open={false} onClose={vi.fn()} />);
        expect(screen.queryByTestId("courtlistener-key-state")).toBeNull();
    });
});
