import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    SkeletonCheckbox,
    TablePrimaryCell,
    tableTreeCellStyle,
} from "./TablePrimitive";

describe("table skeletons", () => {
    it("uses the same geometry as a table checkbox", () => {
        const { container } = render(<SkeletonCheckbox />);

        expect(container.firstChild).toHaveClass(
            "mr-3",
            "h-2.5",
            "w-2.5",
            "shrink-0",
        );
    });
});

describe("table tree indentation", () => {
    it("centers each child checkbox beneath its parent chevron", () => {
        expect(tableTreeCellStyle(1)).toEqual({ paddingLeft: 37 });
        expect(tableTreeCellStyle(2)).toEqual({ paddingLeft: 62 });
    });

    it("applies tree indentation to primary cells", () => {
        render(
            <TablePrimaryCell
                label="Nested workflow"
                selected={false}
                onSelectionChange={vi.fn()}
                style={tableTreeCellStyle(1)}
            />,
        );

        expect(
            screen.getByRole("checkbox", {
                name: "Select Nested workflow",
            }).parentElement?.parentElement,
        ).toHaveStyle({ paddingLeft: "37px" });
    });
});
