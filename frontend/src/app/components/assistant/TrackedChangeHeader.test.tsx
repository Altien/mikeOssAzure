import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrackedChangeHeader } from "./TrackedChangeHeader";

describe("TrackedChangeHeader", () => {
    it("shows only the numbered circle in the header", () => {
        render(
            <TrackedChangeHeader
                changeNumber={3}
                edit={{
                    edit_id: "edit-1",
                    document_id: "document-1",
                    version_id: "version-1",
                    change_id: "change-1",
                    deleted_text: "old text",
                    inserted_text: "new text",
                    status: "pending",
                }}
            />,
        );

        expect(screen.getByLabelText("Tracked change 3")).toHaveTextContent(
            "3",
        );
        expect(screen.queryByText("Tracked Change")).not.toBeInTheDocument();
    });
});
