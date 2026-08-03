import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { TRSidePanel } from "./TRSidePanel";

// Dev adaptation of upstream 6ae1f98d: dev's viewers live at ../shared/DocView
// and ../shared/DocxView (upstream's views/* stack is deferred), and folder
// rows use lucide icons.
vi.mock("../shared/DocView", () => ({
    DocView: ({ doc }: { doc: { document_id: string } }) => (
        <div>PDF {doc.document_id}</div>
    ),
}));
vi.mock("../shared/DocxView", () => ({
    DocxView: () => <div>DOCX</div>,
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

        render(
            <TRSidePanel
                cell={cell}
                row={row}
                documents={documents}
                column={column}
                columns={[column]}
                onClose={vi.fn()}
                onNavigate={vi.fn()}
            />,
        );

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
