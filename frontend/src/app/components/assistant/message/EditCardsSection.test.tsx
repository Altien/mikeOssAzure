import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditCardsSection } from "./EditCardsSection";

describe("EditCardsSection", () => {
    it("pushes the bulk View action to the right edge", () => {
        const annotation = {
            edit_id: "edit-1",
            document_id: "document-1",
            version_id: "version-1",
            change_id: "change-1",
            deleted_text: "old text",
            inserted_text: "new text",
            status: "pending" as const,
        };

        render(
            <EditCardsSection
                pending={[{ annotation, filename: "agreement.docx" }]}
                filenameByDocId={
                    new Map([["document-1", "agreement.docx"]])
                }
                cards={[
                    <div key="one">First change</div>,
                    <div key="two">Second change</div>,
                ]}
                resolvedCount={0}
                onViewClick={vi.fn()}
            />,
        );

        const view = screen.getByRole("button", { name: "View" });
        expect(view).toHaveClass("ml-auto");
        expect(view.parentElement).toHaveClass("w-full");
    });
});
