import { describe, expect, it } from "vitest";
import {
    mergeAssistantSidePanelTab,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";

function documentTab(
    overrides: Partial<AssistantSidePanelTab> = {},
): AssistantSidePanelTab {
    return {
        kind: "document",
        id: "document-1",
        documentId: "document-1",
        filename: "agreement.docx",
        versionId: null,
        versionNumber: null,
        ...overrides,
    } as AssistantSidePanelTab;
}

describe("mergeAssistantSidePanelTab", () => {
    it("returns the existing tab for another plain-document link", () => {
        const existing = documentTab();
        const incoming = documentTab({
            versionId: "explicit-version",
            versionNumber: 3,
        });

        expect(mergeAssistantSidePanelTab(existing, incoming)).toBe(existing);
    });

    it("changes citation context without changing the mounted viewer tuple", () => {
        const existing = documentTab({
            warning: "Preserved warning",
            initialScrollTop: 240,
        });
        const incoming = documentTab({
            kind: "citation",
            filename: "renamed-agreement.docx",
            versionId: "citation-version",
            versionNumber: 4,
            citation: {
                type: "citation_data",
                kind: "document",
                ref: 1,
                doc_id: "doc-0",
                document_id: "document-1",
                filename: "renamed-agreement.docx",
                page: 2,
                quote: "Relevant clause",
                quotes: [{ page: 2, quote: "Relevant clause" }],
            },
        });

        expect(mergeAssistantSidePanelTab(existing, incoming)).toMatchObject({
            kind: "citation",
            id: "document-1",
            documentId: "document-1",
            filename: "agreement.docx",
            versionId: null,
            versionNumber: null,
            warning: "Preserved warning",
            initialScrollTop: 240,
        });
    });
});
