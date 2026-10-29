import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGoogleDriveStatus, getGoogleWorkspaceStatus } from "@/app/lib/mikeApi";
import { useGoogleConnector } from "./useGoogleConnector";

// This harness renders authenticated work without booting the session provider.
// Keep the real owner/generation hooks; only supply their controlled auth input.
const authenticatedOwner = vi.hoisted(() => ({
  user: { id: "u1", email: "owner@example.com", pendingEmail: null, createdWithGoogle: false },
  isAuthenticated: true, authLoading: false, authError: null,
  signOut: vi.fn(async () => {}), signInLocal: vi.fn(async () => {}),
  getAccessToken: vi.fn(async () => "test-token"), updateEmail: vi.fn(), setPassword: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => null), retrySession: vi.fn(async () => null),
}));
vi.mock("@/app/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/app/contexts/AuthContext")>()),
  useAuth: () => authenticatedOwner,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    cancelGoogleDriveOAuth: vi.fn(),
    cancelGoogleWorkspaceOAuth: vi.fn(),
    disconnectGoogleDrive: vi.fn(),
    disconnectGoogleWorkspace: vi.fn(),
    getGoogleDriveStatus: vi.fn(),
    getGoogleWorkspaceStatus: vi.fn(),
    setGoogleDriveToolEnabled: vi.fn(),
    setGoogleWorkspaceToolEnabled: vi.fn(),
    startGoogleDriveOAuth: vi.fn(),
    startGoogleWorkspaceOAuth: vi.fn(),
    updateGoogleDriveSettings: vi.fn(),
    updateGoogleWorkspaceSettings: vi.fn(),
}));
const reporting = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/app/lib/errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/errorReporting")>()),
    ...reporting,
}));

afterEach(() => vi.clearAllMocks());

describe("useGoogleConnector status load", () => {
    it("keeps the card's failed state and reports the fault under the connector's flow", async () => {
        vi.mocked(getGoogleDriveStatus).mockRejectedValue(new Error("status exploded"));

        const { result } = renderHook(() => useGoogleConnector("google-drive", "Google Drive"));

        await waitFor(() => expect(result.current.loadFailed).toBe(true));
        expect(result.current.status).toBeNull();
        expect(reporting.reportError).toHaveBeenCalledTimes(1);
        expect(reporting.reportError.mock.calls[0]![1]).toMatchObject({
            tags: { component: "notify", operation: "google.drive" },
        });
    });

    it("names the Workspace connector that failed", async () => {
        vi.mocked(getGoogleWorkspaceStatus).mockRejectedValue(new Error("x"));

        const { result } = renderHook(() => useGoogleConnector("gmail", "Gmail"));

        await waitFor(() => expect(result.current.loadFailed).toBe(true));
        expect(reporting.reportError.mock.calls[0]![1]).toMatchObject({
            tags: { operation: "google.gmail" },
        });
    });

    it("does not report a 4xx answer from the status route", async () => {
        vi.mocked(getGoogleDriveStatus).mockRejectedValue(
            Object.assign(new Error("not configured"), { status: 404 }),
        );

        const { result } = renderHook(() => useGoogleConnector("google-drive", "Google Drive"));

        await waitFor(() => expect(result.current.loadFailed).toBe(true));
        expect(reporting.reportError).not.toHaveBeenCalled();
    });
});
