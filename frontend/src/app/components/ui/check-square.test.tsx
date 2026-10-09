import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheckSquare } from "./check-square";

function square(container: HTMLElement) {
    return container.querySelector('[data-slot="check-square"]');
}

describe("CheckSquare", () => {
    it("renders a check mark when checked", () => {
        const { container } = render(<CheckSquare state="checked" />);
        const el = square(container);

        expect(el).toHaveAttribute("data-state", "checked");
        expect(el).toHaveClass("bg-gray-900", "border-gray-900");
        expect(
            container.querySelector('[data-slot="check-square-mark"]'),
        ).toBeInTheDocument();
    });

    it("renders a dash when indeterminate", () => {
        const { container } = render(<CheckSquare state="indeterminate" />);

        expect(square(container)).toHaveClass("bg-gray-900", "border-gray-900");
        expect(
            container.querySelector('[data-slot="check-square-dash"]'),
        ).toBeInTheDocument();
    });

    it("renders an empty square when unchecked", () => {
        const { container } = render(<CheckSquare state="unchecked" />);

        expect(square(container)).toHaveClass("border-gray-300");
        expect(
            container.querySelector('[data-slot="check-square-mark"]'),
        ).toBeNull();
    });

    it("uses the muted styling for an unselectable unchecked square", () => {
        const { container } = render(<CheckSquare state="unchecked" muted />);
        expect(square(container)).toHaveClass("border-gray-200", "bg-gray-50");
    });

    it("ignores muted once the square is checked", () => {
        const { container } = render(<CheckSquare state="checked" muted />);
        expect(square(container)).toHaveClass("bg-gray-900");
    });

    it("is hidden from assistive tech because the row owns the semantics", () => {
        const { container } = render(<CheckSquare state="checked" />);
        expect(square(container)).toHaveAttribute("aria-hidden", "true");
    });

    it("stays exposed when the caller gives it a role", () => {
        render(
            <CheckSquare
                state="indeterminate"
                role="checkbox"
                aria-checked="mixed"
                aria-label="Select all files"
            />,
        );

        const box = screen.getByRole("checkbox", { name: "Select all files" });
        expect(box).not.toHaveAttribute("aria-hidden");
        expect(box).toHaveAttribute("aria-checked", "mixed");
    });

    it("forwards click handlers and extra props", () => {
        const onClick = vi.fn();
        const { container } = render(
            <CheckSquare
                state="unchecked"
                title="Select all"
                onClick={onClick}
            />,
        );

        const el = square(container) as HTMLElement;
        expect(el).toHaveAttribute("title", "Select all");

        fireEvent.click(el);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
