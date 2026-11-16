import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupportReport = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createSupportReport,
}));
import { ReportIssueModal, reportIssueConsentText } from "./ReportIssueModal";

function renderModal(hasProject: boolean) {
    render(
        <ReportIssueModal
            open
            chatId="chat-1"
            messageId="message-1"
            hasProject={hasProject}
            onClose={() => {}}
        />,
    );
}

beforeEach(() => {
    createSupportReport.mockReset().mockResolvedValue({ id: "r", access_expires_at: null });
});

describe("ReportIssueModal", () => {
    it("cannot be sent without a description", async () => {
        const user = userEvent.setup();
        renderModal(false);
        const send = screen.getByRole("button", { name: "Send report" });
        expect(send).toBeDisabled();
        await user.type(screen.getByLabelText("What went wrong?"), "   ");
        expect(send).toBeDisabled();
        expect(createSupportReport).not.toHaveBeenCalled();
    });

    it("sends the consent flags and the exact wording shown when ticked", async () => {
        const user = userEvent.setup();
        renderModal(true);
        const consent = reportIssueConsentText(true);
        const checkbox = screen.getByRole("checkbox", { name: consent });
        expect(checkbox).not.toBeChecked();
        expect(consent).toContain("the documents in this project");
        expect(screen.getByText(/ends automatically after 14 days/)).toBeInTheDocument();
        await user.type(screen.getByLabelText("What went wrong?"), " Wrong clause cited ");
        await user.click(checkbox);
        await user.click(screen.getByRole("button", { name: "Send report" }));
        expect(createSupportReport).toHaveBeenCalledExactlyOnceWith({
            chat_id: "chat-1",
            message_id: "message-1",
            description: "Wrong clause cited",
            allow_conversation: true,
            allow_documents: true,
            consent_text: consent,
        });
        expect(await screen.findByRole("status")).toHaveTextContent("Your report has been sent");
    });

    it("sends no access when unticked and omits the project clause without a project", async () => {
        const user = userEvent.setup();
        renderModal(false);
        expect(screen.getByRole("checkbox").closest("label")).not.toHaveTextContent("project");
        await user.type(screen.getByLabelText("What went wrong?"), "Slow");
        await user.click(screen.getByRole("button", { name: "Send report" }));
        expect(createSupportReport).toHaveBeenCalledWith(
            expect.objectContaining({ allow_conversation: false, allow_documents: false }),
        );
    });

    it("shows a generic error and allows a retry", async () => {
        const user = userEvent.setup();
        createSupportReport.mockRejectedValueOnce(new Error("raw database failure"));
        renderModal(false);
        await user.type(screen.getByLabelText("What went wrong?"), "Slow");
        await user.click(screen.getByRole("button", { name: "Send report" }));
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Your report could not be sent");
        expect(alert).not.toHaveTextContent("raw database failure");
        expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
    });
});
