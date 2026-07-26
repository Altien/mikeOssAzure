import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";

const {
    listSkillsMock,
    importSkillZipMock,
    listProjectsMock,
    pushMock,
    postSkillReviewMessageMock,
    getSkillReviewMock,
} = vi.hoisted(() => ({
    listSkillsMock: vi.fn(),
    importSkillZipMock: vi.fn(),
    listProjectsMock: vi.fn(),
    pushMock: vi.fn(),
    postSkillReviewMessageMock: vi.fn(),
    getSkillReviewMock: vi.fn(),
}));

vi.mock("./api", () => ({
    listSkills: listSkillsMock,
    importSkillZip: importSkillZipMock,
    getGitHubSkillImportPolicy: vi.fn().mockResolvedValue(null),
    importSkillFromGitHub: vi.fn(),
    analyseSkillVersion: vi.fn(),
    postSkillReviewMessage: postSkillReviewMessageMock,
    getSkillReview: getSkillReviewMock,
    runSkillVersion: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listProjects: listProjectsMock,
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: pushMock }),
}));

import { SkillsLibrary } from "./SkillsLibrary";

describe("SkillsLibrary", () => {
    beforeEach(() => {
        listSkillsMock.mockReset();
        importSkillZipMock.mockReset();
        listProjectsMock.mockReset();
        listProjectsMock.mockResolvedValue([]);
        pushMock.mockReset();
        postSkillReviewMessageMock.mockReset();
        getSkillReviewMock.mockReset();
        getSkillReviewMock.mockResolvedValue({ pendingActions: [] });
    });

    const draftSkill = {
        id: "skill-1",
        canonicalName: "contract-review",
        displayName: "Contract review",
        description: "Reviews a contract.",
        version: {
            id: "version-1",
            state: "draft",
            analysisState: "succeeded",
            entrypointPath: "SKILL.md",
            contentHash: "hash",
        },
    };

    const enableAction = {
        id: "action-1",
        actionType: "enable_version",
        payloadHash: "hash-one-abcdef",
        payload: {
            executionContract: {
                projectRead: true,
                approvedToolNames: ["list_documents", "generate_docx"],
                mappings: [
                    {
                        requirement: { name: "appropriate tools" },
                        status: "needs_admin_selection",
                        mappedToolNames: [],
                    },
                ],
            },
        },
    };

    it("shows enabled skills without an import control to members", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: false,
            skills: [
                {
                    id: "skill-1",
                    canonicalName: "contract-review",
                    displayName: "Contract review",
                    description: "Reviews a contract.",
                    version: {
                        id: "version-1",
                        state: "enabled",
                        entrypointPath: "contract-review/SKILL.md",
                        contentHash: "hash",
                    },
                },
            ],
        });

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "member-1", email: "member@example.test" },
        });

        expect(
            await screen.findByRole("heading", { name: "Contract review" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Import ZIP"),
        ).not.toBeInTheDocument();
    });

    it("imports a ZIP and refreshes the admin library", async () => {
        listSkillsMock
            .mockResolvedValueOnce({ canManage: true, skills: [] })
            .mockResolvedValueOnce({
                canManage: true,
                skills: [
                    {
                        id: "skill-1",
                        canonicalName: "contract-review",
                        displayName: "Contract review",
                        description: "Reviews a contract.",
                        version: {
                            id: "version-1",
                            state: "draft",
                            entrypointPath: "SKILL.md",
                            contentHash: "hash",
                        },
                    },
                ],
            });
        importSkillZipMock.mockResolvedValue({ id: "snapshot-1", skills: [] });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        const input = await screen.findByLabelText("Import ZIP");
        const file = new File(["zip"], "skill.zip", {
            type: "application/zip",
        });
        await user.upload(input, file);

        await waitFor(() => expect(importSkillZipMock).toHaveBeenCalledWith(file));
        expect(
            await screen.findByRole("heading", { name: "Contract review" }),
        ).toBeInTheDocument();
        expect(listSkillsMock).toHaveBeenCalledTimes(2);
    });

    it("shows the amendable pending action and sends the amendment verbatim", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [draftSkill],
        });
        postSkillReviewMessageMock
            .mockResolvedValueOnce({
                conversationId: "review-1",
                outcome: "proposed",
                action: enableAction,
            })
            .mockResolvedValueOnce({
                conversationId: "review-1",
                outcome: "amended",
                supersededActionId: "action-1",
                action: {
                    ...enableAction,
                    id: "action-2",
                    payloadHash: "hash-two-abcdef",
                    payload: {
                        executionContract: {
                            projectRead: true,
                            approvedToolNames: ["list_documents"],
                            mappings: [],
                        },
                    },
                },
            });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.click(await screen.findByRole("button", { name: "Propose enable" }));
        expect(
            await screen.findByText(/grants nothing until you select a minimum/),
        ).toBeInTheDocument();
        expect(screen.getByText(/list_documents, generate_docx/)).toBeInTheDocument();

        await user.type(
            screen.getByLabelText("Amend this action"),
            "amend tools list_documents",
        );
        await user.click(screen.getByRole("button", { name: "Propose amendment" }));

        await waitFor(() =>
            expect(postSkillReviewMessageMock).toHaveBeenLastCalledWith(
                "version-1",
                "amend tools list_documents",
            ),
        );
        // The panel now restates the amended payload and its new hash.
        expect(await screen.findByText(/hash-two-abc/)).toBeInTheDocument();
    });

    it("surfaces an acquisition proposal and approves it explicitly", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [draftSkill],
        });
        postSkillReviewMessageMock.mockResolvedValueOnce({
            conversationId: "review-1",
            outcome: "proposed",
            action: {
                id: "action-9",
                actionType: "acquire_dependency",
                payloadHash: "acquire-hash-1",
                payload: {
                    dependencyName: "citation-checker",
                    repository: "acme/citation-checker",
                    ref: "main",
                    path: "skills/citation-checker",
                },
            },
        });
        postSkillReviewMessageMock.mockResolvedValue({
            conversationId: "review-1",
            outcome: "acquired",
        });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.click(await screen.findByRole("button", { name: "Propose enable" }));
        expect(
            await screen.findByText(/Authorize acquisition of/),
        ).toBeInTheDocument();
        expect(screen.getByText("acme/citation-checker")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Approve action" }));
        await waitFor(() =>
            expect(postSkillReviewMessageMock).toHaveBeenLastCalledWith(
                "version-1",
                "yes",
            ),
        );
    });

    it("runs a read-only snapshot command and renders its result", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [draftSkill],
        });
        postSkillReviewMessageMock.mockResolvedValue({
            conversationId: "review-1",
            outcome: "snapshot",
            command: { kind: "list" },
            result: [
                {
                    path: "SKILL.md",
                    bytes: 42,
                    readable: true,
                    inert_reason: null,
                },
                {
                    path: "logo.png",
                    bytes: 9,
                    readable: false,
                    inert_reason: "binary",
                },
            ],
        });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.type(
            await screen.findByLabelText("Inspect snapshot (read-only)"),
            "list",
        );
        await user.click(
            screen.getByRole("button", { name: "Run snapshot command" }),
        );

        await waitFor(() =>
            expect(postSkillReviewMessageMock).toHaveBeenCalledWith(
                "version-1",
                "list",
            ),
        );
        expect(
            await screen.findByText(/logo\.png — 9 bytes \(inert: binary\)/),
        ).toBeInTheDocument();
    });
});
