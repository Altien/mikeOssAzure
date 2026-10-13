import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspaceScope } from "@/app/contexts/WorkspaceContext";
import { useDirectoryData } from "./useDirectoryData";

const { getLibrary, listProjectSummaries } = vi.hoisted(() => ({
    getLibrary: vi.fn(),
    listProjectSummaries: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getLibrary,
    getLibraryFolderChildren: vi.fn(),
    getProjectDirectoryLevel: vi.fn(),
    listProjectSummaries,
    // WorkspaceContext reads these; no provider is mounted here.
    listOrgs: vi.fn(async () => []),
    getOrgApiKeys: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" } }),
}));

const FIRM = "org-firm";
function inWorkspace(orgId: string | null) {
    return function Workspace({ children }: { children: ReactNode }) {
        return (
            <DocumentWorkspaceScope orgId={orgId}>
                {children}
            </DocumentWorkspaceScope>
        );
    };
}

// More rows than a page, so there is a next page to ask for.
const manyProjects = Array.from({ length: 60 }, (_, index) => ({
    id: `project-${index}`,
    name: `Matter ${index}`,
}));

describe("useDirectoryData", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getLibrary.mockResolvedValue({
            documents: [],
            folders: [],
            documentsHasMore: false,
        });
        listProjectSummaries.mockResolvedValue([]);
    });

    it("lists the projects of the workspace the picker was opened in", async () => {
        // A chat or review takes documents from its own workspace only, so
        // the Projects tab offers that workspace's projects and no others.
        renderHook(() => useDirectoryData(true, "projects"), {
            wrapper: inWorkspace(FIRM),
        });

        await waitFor(() => expect(listProjectSummaries).toHaveBeenCalled());
        expect(listProjectSummaries).toHaveBeenCalledWith(
            expect.objectContaining({ workspace: FIRM }),
        );
    });

    it("lists personal projects for a personal item", async () => {
        renderHook(() => useDirectoryData(true, "projects"), {
            wrapper: inWorkspace(null),
        });

        await waitFor(() => expect(listProjectSummaries).toHaveBeenCalled());
        expect(listProjectSummaries).toHaveBeenCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );
    });

    it("asks for the next page of projects in the same workspace", async () => {
        listProjectSummaries.mockResolvedValue(manyProjects);
        const { result } = renderHook(
            () => useDirectoryData(true, "projects"),
            { wrapper: inWorkspace(FIRM) },
        );
        await waitFor(() => expect(result.current.projectsHasMore).toBe(true));

        await act(async () => {
            await result.current.loadMoreProjects();
        });

        expect(listProjectSummaries).toHaveBeenCalledTimes(2);
        expect(listProjectSummaries.mock.calls[1][0]).toMatchObject({
            workspace: FIRM,
        });
        expect(listProjectSummaries.mock.calls[1][0].offset).toBeGreaterThan(0);
    });

    it("reads the library of that workspace too", async () => {
        renderHook(() => useDirectoryData(true, "files"), {
            wrapper: inWorkspace(FIRM),
        });

        await waitFor(() => expect(getLibrary).toHaveBeenCalled());
        expect(getLibrary.mock.calls[0][0]).toEqual({
            kind: "files",
            workspace: FIRM,
        });
    });
});
