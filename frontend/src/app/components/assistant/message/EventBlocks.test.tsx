import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AskInputsBlock, DocDownloadBlock } from "./EventBlocks";

describe("DocDownloadBlock", () => {
    it("shows the file icon without a file-type label", () => {
        const { container } = render(
            <DocDownloadBlock
                filename="agreement.docx"
                download_url="/documents/agreement/download"
                versionNumber={2}
            />,
        );

        expect(screen.getByText("agreement")).toHaveClass("text-lg");
        expect(screen.queryByText("DOCX")).not.toBeInTheDocument();
        expect(
            container.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toHaveClass("h-4", "w-4");
    });
});

describe("AskInputsBlock", () => {
    it("collapses completed input details and toggles them from the label", () => {
        render(
            <AskInputsBlock
                event={{
                    type: "ask_inputs",
                    items: [
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                        },
                    ],
                }}
                response={{
                    type: "ask_inputs_response",
                    responses: [
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                            answer: "1 Legal Plaza",
                        },
                    ],
                }}
            />,
        );

        const toggle = screen.getByRole("button", {
            name: "Asked for input",
        });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByText("What is the registered address?"),
        ).not.toBeInTheDocument();

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByText("What is the registered address?"),
        ).toBeInTheDocument();
        expect(screen.getByText("1 Legal Plaza")).toBeInTheDocument();

        fireEvent.click(toggle);
        expect(
            screen.queryByText("What is the registered address?"),
        ).not.toBeInTheDocument();
    });
});
