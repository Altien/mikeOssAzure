import { describe, expect, it } from "vitest";
import {
    mergeAssistantSidePanelTab,
    reorderAssistantSidePanelTabs,
    type AssistantSidePanelTab,
    type DocumentTab,
} from "./AssistantSidePanel";

function documentTab(id = "document-1"): DocumentTab {
    return {
        kind: "document",
        id,
        document: {
            document_id: id,
            title: "agreement.docx",
            type: "docx",
            metadata: [],
            quotes: [],
            version_id: null,
            version_number: null,
        },
    };
}

describe("mergeAssistantSidePanelTab", () => {
    it("returns the existing tab for another plain-document link", () => {
        const existing = documentTab();
        const incoming = documentTab();
        incoming.document.version_id = "explicit-version";
        incoming.document.version_number = 3;

        expect(mergeAssistantSidePanelTab(existing, incoming)).toBe(existing);
    });

    it("changes citation context without changing the mounted viewer tuple", () => {
        const existing: AssistantSidePanelTab = {
            ...documentTab(),
            warning: "Preserved warning",
            initialScrollTop: 240,
        };
        const incoming: AssistantSidePanelTab = {
            ...documentTab(),
            kind: "citation",
            document: {
                ...documentTab().document,
                title: "renamed-agreement.docx",
                version_id: "citation-version",
                version_number: 4,
            },
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
        };

        expect(mergeAssistantSidePanelTab(existing, incoming)).toMatchObject({
            kind: "citation",
            id: "document-1",
            document: {
                document_id: "document-1",
                version_id: null,
                version_number: null,
            },
            warning: "Preserved warning",
            initialScrollTop: 240,
        });
    });
});

describe("reorderAssistantSidePanelTabs", () => {
    const tabs = [
        documentTab("a"),
        documentTab("b"),
        documentTab("c"),
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
