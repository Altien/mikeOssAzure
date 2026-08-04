import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { TRSidePanel } from "./TRSidePanel";

vi.mock("../shared/views/PdfView", () => ({
    PdfView: ({ doc }: { doc: { document_id: string } }) => (
        <div>PDF {doc.document_id}</div>
    ),
}));
vi.mock("../shared/views/DocxView", () => ({
    DocxView: () => <div>DOCX</div>,
}));
vi.mock("../shared/views/SpreadsheetView", () => ({
    SpreadsheetView: () => <div>Spreadsheet</div>,
}));

describe("TRSidePanel", () => {
    it("opens the source document encoded in a grouped-row citation", () => {
        const documents = [
            {
                id: "doc-1",
                filename: "First.pdf",
                file_type: "pdf",
            },
            {
                id: "doc-2",
                filename: "Second.pdf",
                file_type: "pdf",
            },
        ] as Document[];
        const row = {
            id: "row-1",
            label: "Closing",
            row_type: "folder",
            document_id: null,
            source_document_ids: ["doc-1", "doc-2"],
        } as TabularReviewRow;
        const column = {
            index: 0,
            name: "Clause",
            prompt: "Extract the clause",
        } as ColumnConfig;
        const cell = {
            id: "cell-1",
            row_id: row.id,
            column_index: column.index,
            status: "done",
            content: {
                summary:
                    "Answer [[document:doc-2||page:4||quote:Exact language]]",
                flag: "grey",
                reasoning: "",
            },
        } as TabularCell;

        const { container } = render(
            <TRSidePanel
                cell={cell}
                row={row}
                rows={[row]}
                documents={documents}
                column={column}
                columns={[column]}
                onClose={vi.fn()}
                onNavigate={vi.fn()}
            />,
        );

        expect(
            container.querySelector('img[src*="folder-closed"]'),
        ).toBeInTheDocument();

        const folderButton = screen.getByRole("button", { name: "Closing" });
        expect(folderButton).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByRole("button", { name: "First.pdf" }),
        ).not.toBeInTheDocument();

        fireEvent.click(folderButton);

        expect(folderButton).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(screen.getByRole("button", { name: "First.pdf" }));

        expect(screen.getByText("PDF doc-1")).toBeInTheDocument();

        fireEvent.click(screen.getByTitle('Page 4: "Exact language"'));

        expect(screen.getByText("PDF doc-2")).toBeInTheDocument();
    });
});
