import { describe, expect, it } from "vitest";
import {
    mergeAssistantSidePanelTab,
    reorderAssistantSidePanelTabs,
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

describe("reorderAssistantSidePanelTabs", () => {
    const tabs = [
        documentTab({ id: "a", documentId: "a" }),
        documentTab({ id: "b", documentId: "b" }),
        documentTab({ id: "c", documentId: "c" }),
    ];

    it("moves a tab before the drop target", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "c", "a", "before").map(
                (tab) => tab.id,
            ),
        ).toEqual(["c", "a", "b"]);
    });

    it("moves a tab after the drop target", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "a", "b", "after").map(
                (tab) => tab.id,
            ),
        ).toEqual(["b", "a", "c"]);
    });

    it("moves a tab to the right end after the last tab", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "a", "c", "after").map(
                (tab) => tab.id,
            ),
        ).toEqual(["b", "c", "a"]);
    });

    it("keeps the existing array when the drop does not change order", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "a", "b", "before"),
        ).toBe(tabs);
    });
});
