import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GmailImportModal } from "./GmailImportModal";

const { searchGmailMessages, getGmailMessage, importGmailMessage } = vi.hoisted(() => ({
    searchGmailMessages: vi.fn(),
    getGmailMessage: vi.fn(),
    importGmailMessage: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    searchGmailMessages,
    getGmailMessage,
    importGmailMessage,
}));

const summary = {
    id: "m1",
    threadId: "t1",
    subject: "Draft services agreement",
    from: "Client <client@example.com>",
    to: "lawyer@example.com",
    date: "2026-07-29T15:00:00.000Z",
    snippet: "Please review the attached draft.",
    hasAttachments: true,
};

describe("GmailImportModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchGmailMessages.mockResolvedValue({ messages: [summary], resultSizeEstimate: 1 });
        getGmailMessage.mockResolvedValue({
            ...summary,
            cc: "",
            body: "Please review the attached draft before Friday.",
            attachments: [{ filename: "draft.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 100 }],
        });
        importGmailMessage.mockResolvedValue({
            id: "doc-1",
            filename: "Draft services agreement.docx",
            project_id: "project-1",
        });
    });

    it("searches, previews, and imports a Gmail message into the target project", async () => {
        const user = userEvent.setup();
        const onImported = vi.fn();
        const onClose = vi.fn();
        render(
            <GmailImportModal
                open
                projectId="project-1"
                onClose={onClose}
                onImported={onImported}
            />,
        );

        await user.click(await screen.findByRole("button", { name: /Draft services agreement/ }));
        expect(await screen.findByText(/before Friday/)).toBeVisible();
        expect(screen.getByText("draft.docx")).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Import email" }));
        await waitFor(() => expect(importGmailMessage).toHaveBeenCalledWith({
            messageId: "m1",
            projectId: "project-1",
        }));
        expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: "doc-1" }));
        expect(onClose).toHaveBeenCalled();
    });
});
