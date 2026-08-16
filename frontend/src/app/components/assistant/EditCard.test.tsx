import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditCard } from "./EditCard";

const annotation = {
    edit_id: "edit-1",
    document_id: "document-1",
    version_id: "version-1",
    change_id: "change-1",
    deleted_text: "old text",
    inserted_text: "new text",
    reason: "Keep the language precise.",
    status: "pending" as const,
};

describe("EditCard", () => {
    it("runs the shared View action without making the change text clickable", () => {
        const onViewClick = vi.fn();
        render(
            <EditCard
                changeNumber={3}
                annotation={annotation}
                onViewClick={onViewClick}
            />,
        );

        expect(screen.getByLabelText("Tracked change 3")).toHaveTextContent(
            "3",
        );
        expect(screen.getByText(annotation.reason)).toHaveClass(
            "font-serif",
            "text-sm",
        );
        expect(
            screen.getByText(annotation.inserted_text).parentElement,
        ).toHaveClass("font-sans", "text-xs");
        expect(screen.getByText(annotation.inserted_text).parentElement).not.toHaveAttribute(
            "role",
            "button",
        );
        fireEvent.click(screen.getByRole("button", { name: "View" }));
        expect(onViewClick).toHaveBeenCalledWith(annotation);
    });
});
