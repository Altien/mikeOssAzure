import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type { Document, TabularReviewRow } from "../shared/types";

const row = {
    id: "row-1",
    label: "Contracts",
    row_type: "folder",
    document_id: null,
    source_document_ids: ["doc-1", "doc-2"],
} as TabularReviewRow;
const documents = [
    {
        id: "doc-1",
        filename: "Agreement.pdf",
        file_type: "pdf",
    },
    {
        id: "doc-2",
        filename: "Schedule.docx",
        file_type: "docx",
    },
] as Document[];

function renderTable(
    documentGrouping: "document" | "folder" = "folder",
) {
    return render(
        <TRTable
            loading={false}
            documentGrouping={documentGrouping}
            columns={[]}
            rows={[row]}
            documents={documents}
            cells={[]}
            savingColumn={false}
            savingColumnsConfig={false}
            selectedRowIds={[]}
            onSelectionChange={vi.fn()}
            onExpand={vi.fn()}
            onCitationClick={vi.fn()}
            onUpdateColumn={vi.fn()}
            onDeleteColumn={vi.fn()}
            onAddColumn={vi.fn()}
            onAddDocuments={vi.fn()}
        />,
    );
}

describe("TRTable", () => {
    // The grid here is div-based (no table/columnheader/rowheader roles), so
    // this asserts on rendered content rather than ARIA table semantics.
    it("renders one table row for a grouped folder", () => {
        renderTable();
        expect(screen.getByText("Folder / Document")).toBeInTheDocument();
        expect(screen.getByText("Contracts")).toBeInTheDocument();
        // One select-all checkbox in the header plus one per logical review row.
        expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("uses Document as the header for document grouping", () => {
        renderTable("document");
        expect(screen.getByText("Document")).toBeInTheDocument();
        expect(
            screen.queryByText("Folder / Document"),
        ).not.toBeInTheDocument();
    });

    it("expands a folder row to list its source documents", () => {
        renderTable();
        fireEvent.click(screen.getByText("Contracts"));
        expect(screen.getByText("Agreement.pdf")).toBeInTheDocument();
        expect(screen.getByText("Schedule.docx")).toBeInTheDocument();
    });
});
