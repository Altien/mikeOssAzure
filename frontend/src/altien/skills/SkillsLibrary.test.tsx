import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";

const { listSkillsMock, importSkillZipMock } = vi.hoisted(() => ({
    listSkillsMock: vi.fn(),
    importSkillZipMock: vi.fn(),
}));

vi.mock("./api", () => ({
    listSkills: listSkillsMock,
    importSkillZip: importSkillZipMock,
}));

import { SkillsLibrary } from "./SkillsLibrary";

describe("SkillsLibrary", () => {
    beforeEach(() => {
        listSkillsMock.mockReset();
        importSkillZipMock.mockReset();
    });

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
});
