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
    deleteSkillVersionMock,
} = vi.hoisted(() => ({
    listSkillsMock: vi.fn(),
    importSkillZipMock: vi.fn(),
    listProjectsMock: vi.fn(),
    pushMock: vi.fn(),
    postSkillReviewMessageMock: vi.fn(),
    getSkillReviewMock: vi.fn(),
    deleteSkillVersionMock: vi.fn(),
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
    deleteSkillVersion: deleteSkillVersionMock,
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
        deleteSkillVersionMock.mockReset();
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

    /** An enable action whose contract exercises every rendering branch. */
    const fullContractAction = {
        id: "action-full",
        actionType: "enable_version",
        payloadHash: "hash-full-abcdef",
        payload: {
            executionContract: {
                projectRead: true,
                approvedToolNames: [
                    "list_documents",
                    "mcp_dingduff_opinion_store_2500a7a0",
                ],
                toolLabels: {
                    mcp_dingduff_opinion_store_2500a7a0:
                        "MCP://DingDuff/opinion_store",
                },
                mappings: [
                    {
                        requirement: {
                            name: "read project documents",
                            kind: "project_read",
                            required: true,
                        },
                        status: "compatible",
                        mappedToolNames: ["list_documents"],
                    },
                    {
                        requirement: {
                            name: "opinion store lookup",
                            kind: "mcp",
                            required: true,
                        },
                        status: "llm_compatible",
                        mappedToolNames: [
                            "mcp_dingduff_opinion_store_2500a7a0",
                        ],
                    },
                    {
                        requirement: {
                            name: "Local python3 with bundled scripts (verify_anchors.py, split_sections.py)",
                            kind: "local_execution",
                            required: true,
                        },
                        status: "not_executed",
                        mappedToolNames: [],
                        llmReason:
                            "1 of 2 behaviours already exist as Mike tools.",
                        atoms: [
                            {
                                label: "verify anchors",
                                intent: "check every anchor resolves",
                                mappedToolNames: ["find_in_document"],
                                reason: "find_in_document performs the lookup.",
                            },
                            {
                                label: "split sections",
                                intent: "cut the document into sections",
                                mappedToolNames: [],
                                reason: "No available tool performs this.",
                            },
                        ],
                    },
                    {
                        requirement: {
                            name: "optional citation polish",
                            kind: "tool",
                            required: false,
                        },
                        status: "invented_future_status",
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

    it("offers a disabled version a way back into review", async () => {
        // An enabled version is immutable, so disabling is the only route to a
        // rebuilt contract. Gating the controls on "draft" alone left a
        // disabled skill with nothing to click at all.
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [
                {
                    ...draftSkill,
                    version: { ...draftSkill.version, state: "disabled" },
                },
            ],
        });

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        expect(
            await screen.findByRole("button", { name: "Re-analyse" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Propose enable" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/no project can reach it/i)).toBeInTheDocument();
    });

    it("keeps an enabled version out of review", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [
                {
                    ...draftSkill,
                    version: { ...draftSkill.version, state: "enabled" },
                },
            ],
        });

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        expect(
            await screen.findByRole("heading", { name: "Contract review" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Re-analyse" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Propose enable" }),
        ).not.toBeInTheDocument();
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

    /** Proposes the enable action above and returns once its panel is up. */
    async function openFullContract() {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [draftSkill],
        });
        postSkillReviewMessageMock.mockResolvedValueOnce({
            conversationId: "review-1",
            outcome: "proposed",
            action: fullContractAction,
        });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.click(
            await screen.findByRole("button", { name: "Propose enable" }),
        );
        expect(await screen.findByText(/Capability mapping/)).toBeInTheDocument();
    }

    it("lists every capability mapping, not only the unresolved ones", async () => {
        await openFullContract();

        expect(screen.getByText("Capability mapping (4)")).toBeInTheDocument();
        expect(screen.getByText("read project documents")).toBeInTheDocument();
        expect(screen.getByText("opinion store lookup")).toBeInTheDocument();
        expect(
            screen.getByText(/Local python3 with bundled scripts/),
        ).toBeInTheDocument();
        expect(screen.getByText("optional citation polish")).toBeInTheDocument();
        // The two plainly mapped requirements read as mapped rather than as
        // their raw enum values.
        expect(screen.getAllByText("mapped")).toHaveLength(2);
    });

    it("shows a not_executed requirement as never executed here", async () => {
        await openFullContract();

        expect(screen.getByText("never executed here")).toBeInTheDocument();
        expect(
            screen.getByText(/1 of 2 behaviours already exist as Mike tools/),
        ).toBeInTheDocument();
    });

    it("renders an MCP tool by its label, never its wire name", async () => {
        await openFullContract();

        expect(
            screen.getAllByText(/MCP:\/\/DingDuff\/opinion_store/).length,
        ).toBeGreaterThan(0);
        expect(
            screen.queryByText(/mcp_dingduff_opinion_store_2500a7a0/),
        ).not.toBeInTheDocument();
    });

    it("breaks a multi-behaviour requirement down per atom", async () => {
        await openFullContract();

        expect(screen.getByText(/verify anchors/)).toBeInTheDocument();
        expect(screen.getByText("find_in_document")).toBeInTheDocument();
        // The behaviour Mike does not cover is named as such, rather than
        // being hidden behind the requirement's single verdict.
        expect(screen.getByText(/split sections/)).toBeInTheDocument();
        expect(screen.getByText("no equivalent")).toBeInTheDocument();
    });

    it("falls back to the raw status for an unrecognised mapping status", async () => {
        await openFullContract();

        expect(
            screen.getByText("invented_future_status"),
        ).toBeInTheDocument();
        expect(screen.getByText("optional")).toBeInTheDocument();
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

    it("deletes a draft only after an explicit confirmation, then refreshes", async () => {
        listSkillsMock
            .mockResolvedValueOnce({ canManage: true, skills: [draftSkill] })
            .mockResolvedValueOnce({ canManage: true, skills: [] });
        deleteSkillVersionMock.mockResolvedValue({
            versionId: "version-1",
            skillId: "skill-1",
            skillDeleted: true,
            snapshotDeleted: true,
        });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.click(
            await screen.findByRole("button", { name: "Delete draft" }),
        );
        // The first click only asks; nothing has been deleted yet.
        expect(deleteSkillVersionMock).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/cannot be undone/),
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await waitFor(() =>
            expect(deleteSkillVersionMock).toHaveBeenCalledWith("version-1"),
        );
        expect(listSkillsMock).toHaveBeenCalledTimes(2);
        expect(
            await screen.findByText("No skills are available yet"),
        ).toBeInTheDocument();
    });

    it("keeps the draft when the delete confirmation is cancelled", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [draftSkill],
        });
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.click(
            await screen.findByRole("button", { name: "Delete draft" }),
        );
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(deleteSkillVersionMock).not.toHaveBeenCalled();
        expect(screen.queryByText(/cannot be undone/)).not.toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Contract review" }),
        ).toBeInTheDocument();
    });

    it("reports a refused delete without removing the card", async () => {
        listSkillsMock.mockResolvedValue({
            canManage: true,
            skills: [draftSkill],
        });
        deleteSkillVersionMock.mockRejectedValue(
            new Error("A project pins this skill version."),
        );
        const user = userEvent.setup();

        renderWithProviders(<SkillsLibrary />, {
            user: { id: "admin-1", email: "admin@example.test" },
        });

        await user.click(
            await screen.findByRole("button", { name: "Delete draft" }),
        );
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(
            await screen.findByText("A project pins this skill version."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Contract review" }),
        ).toBeInTheDocument();
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
