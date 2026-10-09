import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getProject } from "@/app/lib/mikeApi";
import {
    ProjectWorkspaceProvider,
    useProjectWorkspace,
} from "./ProjectWorkspace";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSelectedLayoutSegments: () => [],
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createTabularReview: vi.fn(),
    deleteProject: vi.fn(),
    getProject: vi.fn(() => new Promise(() => {})),
    getProjectPeople: vi.fn(),
    listProjectChats: vi.fn(),
    setProjectMemoryEnabled: vi.fn(),
    updateProject: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "User" } }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: vi.fn() }),
}));

vi.mock("./ProjectPageParts", () => ({
    ProjectPageHeader: ({
        onUploadFiles,
    }: {
        onUploadFiles?: (() => void) | null;
    }) => <button disabled={!onUploadFiles}>Upload</button>,
}));

vi.mock("@/app/components/tabular/NewTRModal", () => ({
    NewTRModal: () => null,
}));
vi.mock("@/app/components/popups/ConfirmPopup", () => ({
    ConfirmPopup: () => null,
}));
vi.mock("@/app/components/popups/OwnerOnlyPopup", () => ({
    OwnerOnlyPopup: () => null,
}));
vi.mock("@/app/components/modals/AccessModal", () => ({
    AccessModal: () => null,
}));
vi.mock("./ProjectDetailsModal", () => ({
    ProjectDetailsModal: () => null,
}));
// The real modal owns its own reads and reports the enabled flag on every
// load and poll; this stand-in lets a test fire that callback on demand.
vi.mock("./ProjectMemoryModal", () => ({
    ProjectMemoryModal: ({
        onMemoryEnabledChange,
    }: {
        onMemoryEnabledChange: (enabled: boolean) => void;
    }) => (
        <button onClick={() => onMemoryEnabledChange(true)}>
            Report memory enabled
        </button>
    ),
}));

const uploadFiles = vi.fn();

function RegisterUploadAction() {
    const { setDocumentUploadHeaderAction } = useProjectWorkspace();

    useEffect(() => {
        setDocumentUploadHeaderAction("uploadFiles", uploadFiles);
        return () => setDocumentUploadHeaderAction("uploadFiles", null);
    }, [setDocumentUploadHeaderAction]);

    return null;
}

const seenProjects: unknown[] = [];

function TrackProjectIdentity() {
    const { project } = useProjectWorkspace();
    if (project && seenProjects[seenProjects.length - 1] !== project) {
        seenProjects.push(project);
    }
    return null;
}

describe("ProjectWorkspaceProvider", () => {
    it("keeps document upload actions registered on direct project load", async () => {
        render(
            <ProjectWorkspaceProvider projectId="project-1">
                <RegisterUploadAction />
            </ProjectWorkspaceProvider>,
        );

        expect(
            await screen.findByRole("button", { name: "Upload" }),
        ).toBeEnabled();
    });

    it("keeps one project object while the memory poll reports no change", async () => {
        // The memory dialog reports the enabled flag on every load and poll.
        // Rebuilding the project row each time handed every consumer of the
        // workspace context a new object, re-rendering the whole workspace
        // every few seconds for as long as a curator ran.
        seenProjects.length = 0;
        vi.mocked(getProject).mockResolvedValue({
            id: "project-1",
            name: "P",
            memory_enabled: true,
        } as never);
        const user = userEvent.setup();

        render(
            <ProjectWorkspaceProvider projectId="project-1">
                <TrackProjectIdentity />
            </ProjectWorkspaceProvider>,
        );

        const report = await screen.findByRole("button", {
            name: "Report memory enabled",
        });
        await waitFor(() => expect(seenProjects).toHaveLength(1));
        await user.click(report);
        await user.click(report);
        await user.click(report);

        expect(seenProjects).toHaveLength(1);
    });
});
