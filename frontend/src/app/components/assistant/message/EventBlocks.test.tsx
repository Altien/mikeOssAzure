import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocDownloadBlock } from "./EventBlocks";

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
