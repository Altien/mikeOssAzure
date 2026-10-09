import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMessage } from "./UserMessage";

describe("UserMessage", () => {
    it("opens a document-backed file pill", async () => {
        const onFileClick = vi.fn();
        const user = userEvent.setup();
        const file = {
            filename: "agreement.docx",
            document_id: "document-1",
        };

        render(
            <UserMessage
                content="Review this"
                files={[file]}
                onFileClick={onFileClick}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Open agreement.docx" }),
        );
        expect(onFileClick).toHaveBeenCalledWith(file);
    });

    it("reveals the workflow behind the pill", async () => {
        const user = userEvent.setup();
        const onWorkflowClick = vi.fn();
        render(
            <UserMessage
                content="Run the diligence review"
                workflow={{ id: "wf-1", title: "Diligence review" }}
                onWorkflowClick={onWorkflowClick}
            />,
        );

        await user.click(
            screen.getByRole("button", {
                name: "Open workflow Diligence review",
            }),
        );

        expect(onWorkflowClick).toHaveBeenCalledWith({
            id: "wf-1",
            title: "Diligence review",
        });
    });
});
