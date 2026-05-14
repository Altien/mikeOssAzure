import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextSearchWidget } from "./text-search-widget";

function makeProps(overrides: Partial<Parameters<typeof TextSearchWidget>[0]> = {}) {
    return {
        isOpen: true,
        onClose: vi.fn(),
        searchQuery: "",
        onSearchChange: vi.fn(),
        currentMatchIdx: 0,
        matchCount: 0,
        setCurrentMatchIdx: vi.fn(),
        ...overrides,
    };
}

describe("TextSearchWidget", () => {
    it("renders nothing when isOpen=false", () => {
        const { container } = render(
            <TextSearchWidget {...makeProps({ isOpen: false })} />,
        );

        expect(container).toBeEmptyDOMElement();
    });

    it("renders the search input when isOpen=true", () => {
        render(<TextSearchWidget {...makeProps()} />);

        expect(screen.getByPlaceholderText("Find")).toBeInTheDocument();
    });

    it("calls onSearchChange as the user types", async () => {
        const onSearchChange = vi.fn();
        render(<TextSearchWidget {...makeProps({ onSearchChange })} />);

        await userEvent.type(screen.getByPlaceholderText("Find"), "x");

        expect(onSearchChange).toHaveBeenCalledWith("x");
    });

    it("Escape closes the widget AND clears the query", async () => {
        const onClose = vi.fn();
        const onSearchChange = vi.fn();
        render(
            <TextSearchWidget
                {...makeProps({
                    onClose,
                    onSearchChange,
                    searchQuery: "needle",
                })}
            />,
        );

        await userEvent.type(screen.getByPlaceholderText("Find"), "{Escape}");

        expect(onClose).toHaveBeenCalledOnce();
        expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("hides the results bar when searchQuery is empty", () => {
        render(<TextSearchWidget {...makeProps({ searchQuery: "" })} />);

        // The results bar contains the match count and the prev/next
        // buttons; without a query, none of those should be rendered.
        expect(screen.queryByText(/No results/)).not.toBeInTheDocument();
    });

    it("shows '<idx+1> of <count>' for non-zero matches", () => {
        render(
            <TextSearchWidget
                {...makeProps({
                    searchQuery: "the",
                    currentMatchIdx: 2,
                    matchCount: 5,
                })}
            />,
        );

        expect(screen.getByText("3 of 5")).toBeInTheDocument();
    });

    it("shows 'No results' when the query has zero matches", () => {
        render(
            <TextSearchWidget
                {...makeProps({ searchQuery: "xyzzy", matchCount: 0 })}
            />,
        );

        expect(screen.getByText("No results")).toBeInTheDocument();
    });

    it("Enter cycles to the next match; Shift+Enter cycles to the previous", async () => {
        const setCurrentMatchIdx = vi.fn();
        render(
            <TextSearchWidget
                {...makeProps({
                    searchQuery: "x",
                    currentMatchIdx: 1,
                    matchCount: 3,
                    setCurrentMatchIdx,
                })}
            />,
        );

        await userEvent.type(screen.getByPlaceholderText("Find"), "{Enter}");

        // setCurrentMatchIdx is invoked with the "(prev + 1) % count"
        // reducer function; we apply it to the current index to check.
        expect(setCurrentMatchIdx).toHaveBeenLastCalledWith(expect.any(Function));
        const lastReducer = setCurrentMatchIdx.mock.lastCall![0] as (
            prev: number,
        ) => number;
        expect(lastReducer(1)).toBe(2);
        // Wrap-around: from the last match, next goes back to 0.
        expect(lastReducer(2)).toBe(0);

        await userEvent.type(
            screen.getByPlaceholderText("Find"),
            "{Shift>}{Enter}{/Shift}",
        );

        const prevReducer = setCurrentMatchIdx.mock.lastCall![0] as (
            prev: number,
        ) => number;
        expect(prevReducer(1)).toBe(0);
        // Wrap-around: from 0, prev goes to the last match.
        expect(prevReducer(0)).toBe(2);
    });

    it("Enter / arrow buttons are no-ops when matchCount is 0", async () => {
        const setCurrentMatchIdx = vi.fn();
        render(
            <TextSearchWidget
                {...makeProps({
                    searchQuery: "x",
                    matchCount: 0,
                    setCurrentMatchIdx,
                })}
            />,
        );

        await userEvent.type(screen.getByPlaceholderText("Find"), "{Enter}");

        // The handler returns early; no reducer call.
        expect(setCurrentMatchIdx).not.toHaveBeenCalled();
    });

    it("arrow buttons trigger prev/next when there are matches", async () => {
        const setCurrentMatchIdx = vi.fn();
        render(
            <TextSearchWidget
                {...makeProps({
                    searchQuery: "x",
                    currentMatchIdx: 0,
                    matchCount: 4,
                    setCurrentMatchIdx,
                })}
            />,
        );

        const buttons = screen.getAllByRole("button");
        // Two arrow buttons rendered in DOM order: prev then next.
        await userEvent.click(buttons[0]);
        await userEvent.click(buttons[1]);

        expect(setCurrentMatchIdx).toHaveBeenCalledTimes(2);
        const prevReducer = setCurrentMatchIdx.mock.calls[0][0] as (
            n: number,
        ) => number;
        const nextReducer = setCurrentMatchIdx.mock.calls[1][0] as (
            n: number,
        ) => number;
        expect(prevReducer(0)).toBe(3);
        expect(nextReducer(0)).toBe(1);
    });

    it("arrow buttons are disabled when matchCount=0", () => {
        render(
            <TextSearchWidget
                {...makeProps({ searchQuery: "x", matchCount: 0 })}
            />,
        );

        for (const btn of screen.getAllByRole("button")) {
            expect(btn).toBeDisabled();
        }
    });
});
