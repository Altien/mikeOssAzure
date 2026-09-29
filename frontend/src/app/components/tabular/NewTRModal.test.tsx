import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewTRModal } from "./NewTRModal";

vi.mock("@/app/lib/mikeApi", () => ({
    getProject: vi.fn(),
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({ tabs }: { tabs?: string[] }) => (
        <div>
            Document directory
            <span data-testid="directory-tabs">{tabs?.join(",")}</span>
        </div>
    ),
}));

describe("NewTRModal", () => {
    it("shows folder grouping on the first screen and excludes Templates", () => {
        const onAdd = vi.fn();
        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={onAdd}
            />,
        );

        expect(screen.getByText("Document grouping")).toBeInTheDocument();
        expect(
            screen.getByText(
                "Treat documents in the same folder as one review row",
            ),
        ).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Closing review" },
        });
        const groupingSwitch = screen.getByRole("switch", {
            name: "Treat documents in the same folder as one review row",
        });
        expect(groupingSwitch).toHaveAttribute("aria-checked", "false");
        fireEvent.click(groupingSwitch);
        expect(groupingSwitch).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.getByText("Document directory")).toBeInTheDocument();
        expect(screen.getByTestId("directory-tabs")).toHaveTextContent(
            "files,projects",
        );
        expect(screen.queryByText("Document grouping")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(onAdd).toHaveBeenCalledWith(
            "Closing review",
            undefined,
            undefined,
            undefined,
            "folder",
        );
    });
});
