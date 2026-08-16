import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocPanel, DocumentTitleRow } from "./DocPanel";

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

describe("case source", () => {
    it("uses the shared header actions and metadata above the case view", () => {
        const { container } = render(
            <DocPanel
                kind="case"
                compactActions={false}
                tab={{
                    kind: "case",
                    id: "case:123",
                    chatId: "chat-1",
                    clusterId: 123,
                    caseName: "Example v Example",
                    citation: "[2024] UKSC 1",
                    url: "https://www.courtlistener.com/opinion/123/example/",
                    dateFiled: "2024-01-02",
                    pdfUrl: "https://example.com/opinion.pdf",
                    quotes: [],
                    opinions: [
                        {
                            opinionId: 456,
                            type: "lead",
                            author: "Justice Example",
                            html: "<p>Opinion text.</p>",
                            text: null,
                            url: null,
                        },
                    ],
                }}
            />,
        );

        expect(
            screen.getByRole("heading", {
                name: "Example v Example, [2024] UKSC 1",
            }),
        ).toHaveClass("text-sm", "font-medium");
        expect(
            screen.getByRole("heading", {
                name: "Example v Example, [2024] UKSC 1",
            }),
        ).not.toHaveClass("font-serif");
        const metadata = screen.getByText("Date: January 2, 2024");
        expect(metadata.parentElement).toHaveClass("w-full");
        expect(metadata.parentElement).not.toHaveClass("pl-6");
        expect(metadata.parentElement).not.toBe(
            screen.getByRole("heading", {
                name: "Example v Example, [2024] UKSC 1",
            }).parentElement,
        );

        const download = screen.getByRole("link", { name: "Download" });
        expect(download).toHaveAttribute(
            "href",
            "https://example.com/opinion.pdf",
        );
        expect(download).toHaveClass("rounded-full");
        expect(screen.queryByText("PDF")).not.toBeInTheDocument();

        expect(
            screen.getByRole("link", { name: "Open in CourtListener" }),
        ).toHaveAttribute(
            "href",
            "https://www.courtlistener.com/opinion/123/example/",
        );
        expect(
            container.querySelector(
                'img[src*="/icons/legal-sources/case-law.svg"]',
            ),
        ).toHaveClass("h-4", "w-4");
    });
});
