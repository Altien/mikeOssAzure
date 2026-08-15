import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

describe("AssistantMessage document events", () => {
    it("opens every identified event document in the document panel", () => {
        const onOpenDocument = vi.fn();
        const events: AssistantEvent[] = [
            {
                type: "doc_read",
                filename: "read.docx",
                document_id: "document-read",
            },
            {
                type: "doc_find",
                filename: "searched.pdf",
                document_id: "document-find",
                query: "termination",
                total_matches: 2,
            },
            {
                type: "doc_created",
                filename: "created.docx",
                document_id: "document-created",
                version_id: "version-created",
                version_number: 3,
                download_url: "",
            },
            {
                type: "doc_replicated",
                filename: "template.docx",
                count: 2,
                copies: [
                    {
                        new_filename: "copy-one.docx",
                        document_id: "document-copy-one",
                        version_id: "version-copy-one",
                    },
                    {
                        new_filename: "copy-two.docx",
                        document_id: "document-copy-two",
                        version_id: "version-copy-two",
                    },
                ],
            },
            {
                type: "doc_edited",
                filename: "edited.docx",
                document_id: "document-edited",
                version_id: "version-edited",
                version_number: 4,
                download_url: "",
                annotations: [],
            },
        ];

        const { container } = render(
            <AssistantMessage
                events={events}
                onOpenDocument={onOpenDocument}
            />,
        );

        expect(
            container.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "read.docx" }));
        fireEvent.click(
            screen.getByRole("button", { name: "searched.pdf" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "created.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "copy-one.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "copy-two.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "edited.docx" }),
        );

        expect(onOpenDocument.mock.calls).toEqual([
            [
                {
                    documentId: "document-read",
                    filename: "read.docx",
                    versionId: null,
                    versionNumber: null,
                },
            ],
            [
                {
                    documentId: "document-find",
                    filename: "searched.pdf",
                    versionId: null,
                    versionNumber: null,
                },
            ],
            [
                {
                    documentId: "document-created",
                    filename: "created.docx",
                    versionId: "version-created",
                    versionNumber: 3,
                },
            ],
            [
                {
                    documentId: "document-copy-one",
                    filename: "copy-one.docx",
                    versionId: "version-copy-one",
                    versionNumber: 1,
                },
            ],
            [
                {
                    documentId: "document-copy-two",
                    filename: "copy-two.docx",
                    versionId: "version-copy-two",
                    versionNumber: 1,
                },
            ],
            [
                {
                    documentId: "document-edited",
                    filename: "edited.docx",
                    versionId: "version-edited",
                    versionNumber: 4,
                },
            ],
        ]);
    });
});
