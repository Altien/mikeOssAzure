import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenameableTitle } from "./RenameableTitle";

describe("RenameableTitle", () => {
    it("renders the value as a clickable span in the idle state", () => {
        render(<RenameableTitle value="Untitled Doc" onCommit={() => {}} />);

        expect(screen.getByText("Untitled Doc")).toBeInTheDocument();
        // Not an input until clicked.
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("renders a suffix node after the value", () => {
        render(
            <RenameableTitle
                value="Doc"
                onCommit={() => {}}
                suffix={<span data-testid="suffix">·v3</span>}
            />,
        );

        expect(screen.getByTestId("suffix")).toBeInTheDocument();
    });

    it("clicking the title switches to an editable input seeded with the current value", async () => {
        render(<RenameableTitle value="Hello" onCommit={() => {}} />);

        await userEvent.click(screen.getByText("Hello"));

        const input = screen.getByRole("textbox") as HTMLInputElement;
        expect(input.value).toBe("Hello");
        // Auto-focused.
        expect(input).toHaveFocus();
    });

    it("Enter commits the edited value, trimmed", async () => {
        const onCommit = vi.fn();
        render(<RenameableTitle value="old" onCommit={onCommit} />);
        await userEvent.click(screen.getByText("old"));
        const input = screen.getByRole("textbox");

        // Clear and type the new value with surrounding whitespace.
        await userEvent.clear(input);
        await userEvent.type(input, "  new title  {Enter}");

        expect(onCommit).toHaveBeenCalledWith("new title");
        // Back to span view.
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("blur commits the edit (clicking away saves)", async () => {
        const onCommit = vi.fn();
        render(<RenameableTitle value="x" onCommit={onCommit} />);
        await userEvent.click(screen.getByText("x"));
        const input = screen.getByRole("textbox");
        await userEvent.clear(input);
        await userEvent.type(input, "saved");

        // Click somewhere else to blur.
        await userEvent.click(document.body);

        expect(onCommit).toHaveBeenCalledWith("saved");
    });

    it("Escape cancels the edit — no onCommit, original value still shown", async () => {
        const onCommit = vi.fn();
        render(<RenameableTitle value="keep" onCommit={onCommit} />);
        await userEvent.click(screen.getByText("keep"));
        const input = screen.getByRole("textbox");
        await userEvent.clear(input);
        await userEvent.type(input, "discard{Escape}");

        expect(onCommit).not.toHaveBeenCalled();
        // The escape branch sets `escaped.current = true` and exits
        // editing without committing; the rendered span goes back to
        // the original prop value.
        expect(screen.getByText("keep")).toBeInTheDocument();
    });

    it("committing an empty/whitespace-only draft sends '' through to the caller", async () => {
        // The trim+commit is "the caller decides" — if the caller
        // wants to reject empties they can.  The component itself
        // hands through the trimmed string.
        const onCommit = vi.fn();
        render(<RenameableTitle value="x" onCommit={onCommit} />);
        await userEvent.click(screen.getByText("x"));
        const input = screen.getByRole("textbox");
        await userEvent.clear(input);
        await userEvent.type(input, "   {Enter}");

        expect(onCommit).toHaveBeenCalledWith("");
    });
});
