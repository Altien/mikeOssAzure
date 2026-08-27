import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybookPickerModal } from "./PlaybookPickerModal";

const { listPlaybooks } = vi.hoisted(() => ({
    listPlaybooks: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({ listPlaybooks }));

const content = (name: string) => ({
    name,
    description: "",
    globalGuidance: "",
    representedParty: "Customer",
    documentTypes: ["MSA"],
    jurisdictions: [],
    topics: [{ id: "topic-1", name: "Liability", rules: [] }],
});

const playbooks = [
    {
        id: "draft-1",
        userId: "user-1",
        name: "Draft Playbook",
        description: "",
        status: "draft",
        draft: content("Draft Playbook"),
        publishedVersionId: null,
        publishedVersionNumber: null,
        publishedName: null,
        sourceFilename: null,
        importModel: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
    },
    {
        id: "published-1",
        userId: "user-1",
        name: "Renamed Draft",
        description: "Customer policy",
        status: "draft",
        draft: content("Renamed Draft"),
        publishedVersionId: "version-1",
        publishedVersionNumber: 2,
        publishedName: "Published MSA Playbook",
        sourceFilename: null,
        importModel: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
    },
];

describe("PlaybookPickerModal", () => {
    beforeEach(() => {
        listPlaybooks.mockResolvedValue(playbooks);
    });

    it("selects the immutable published playbook name and version", async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <PlaybookPickerModal
                open
                onClose={onClose}
                onSelect={onSelect}
            />,
        );

        expect(
            await screen.findAllByText("Published MSA Playbook"),
        ).toHaveLength(2);
        await user.click(screen.getByRole("button", { name: "Use playbook" }));

        expect(onSelect).toHaveBeenCalledWith({
            id: "published-1",
            title: "Published MSA Playbook",
            version: 2,
            versionId: "version-1",
        });
        expect(onClose).toHaveBeenCalled();
    });

    it("does not allow a draft-only playbook to be used", async () => {
        const user = userEvent.setup();
        render(
            <PlaybookPickerModal open onClose={vi.fn()} onSelect={vi.fn()} />,
        );

        await user.click(await screen.findByRole("button", { name: /Draft Playbook/ }));
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Use playbook" }),
            ).toBeDisabled(),
        );
        expect(
            screen.getByText(/Publish this playbook before using it/i),
        ).toBeVisible();
    });
});
