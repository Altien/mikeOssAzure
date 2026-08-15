import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentTitleRow } from "./DocPanel";

describe("DocumentTitleRow", () => {
    it("uses a compact sans-serif title with the file-type icon", () => {
        const { container } = render(
            <DocumentTitleRow
                documentId="document-1"
                filename="agreement.docx"
                versionId="version-1"
                versionNumber={1}
                isReloading={false}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "agreement.docx",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");
        expect(
            container.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toBeInTheDocument();
    });
});
