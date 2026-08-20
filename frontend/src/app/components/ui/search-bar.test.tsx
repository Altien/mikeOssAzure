import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./search-bar";

describe("SearchBar", () => {
    it("gives the input a default accessible name", () => {
        render(<SearchBar value="" onValueChange={() => {}} />);
        expect(
            screen.getByRole("searchbox", { name: "Search" }),
        ).toBeInTheDocument();
    });

    it("lets callers override the accessible name", () => {
        render(
            <SearchBar
                value=""
                onValueChange={() => {}}
                aria-label="Search workflows"
            />,
        );
        expect(
            screen.getByRole("searchbox", { name: "Search workflows" }),
        ).toBeInTheDocument();
    });

    it("shows a focus ring on the wrapper because the input suppresses its outline", () => {
        const { container } = render(
            <SearchBar value="" onValueChange={() => {}} />,
        );
        expect(
            container.querySelector('[data-slot="search-bar"]'),
        ).toHaveClass("focus-within:ring-2");
    });

    it("clears the value from the labelled clear button", async () => {
        const onValueChange = vi.fn();
        const user = userEvent.setup();
        render(<SearchBar value="draft" onValueChange={onValueChange} />);

        await user.click(screen.getByRole("button", { name: "Clear search" }));

        expect(onValueChange).toHaveBeenCalledWith("");
    });

    it("gives the clear button a visible focus ring", () => {
        render(<SearchBar value="draft" onValueChange={() => {}} />);
        expect(
            screen.getByRole("button", { name: "Clear search" }),
        ).toHaveClass("focus-visible:ring-2");
    });
});
