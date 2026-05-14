import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CiteButton } from "./cite-button";

// jsdom doesn't ship a clipboard implementation; install one once for
// the file so navigator.clipboard.writeText is always a vi.fn().
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: clipboardWriteText },
    });
});

beforeEach(() => {
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
});

describe("CiteButton", () => {
    it("renders the QuoteIcon + 'Cite' text in the idle state", () => {
        render(
            <CiteButton quoteText="quoted bit" citationText="(Source, 2024)" />,
        );

        expect(screen.getByRole("button", { name: /Cite/ })).toBeInTheDocument();
        expect(screen.getByText("Cite")).toBeInTheDocument();
    });

    it("copies the compiled quote+citation to the clipboard on click", async () => {
        render(
            <CiteButton
                quoteText='quoted "with" inner quotes'
                citationText="(Source, 2024)"
            />,
        );

        await userEvent.click(screen.getByRole("button"));

        // The "Cite" button writes: `"<quote>" <citation>` with the
        // inner double-quotes downgraded to single quotes so the
        // pasted string parses cleanly inside another double-quoted
        // context.
        expect(clipboardWriteText).toHaveBeenCalledWith(
            "\"quoted 'with' inner quotes\" (Source, 2024)",
        );
    });

    it("flips to 'Copied' on click", async () => {
        // Synchronous post-click assertion — the success-path
        // setIsCopied(true) fires once writeText resolves.
        render(<CiteButton quoteText="q" citationText="c" />);

        await userEvent.click(screen.getByRole("button"));

        await waitFor(() =>
            expect(screen.getByText("Copied")).toBeInTheDocument(),
        );
    });

    it("reverts to 'Cite' after the 2-second timeout (fake timers)", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            render(<CiteButton quoteText="q" citationText="c" />);

            // shouldAdvanceTime lets userEvent's internals advance the
            // clock for their own awaits, so the click still works.
            await userEvent.click(screen.getByRole("button"));
            await waitFor(() =>
                expect(screen.getByText("Copied")).toBeInTheDocument(),
            );

            // Cross the 2s threshold — back to "Cite".
            await act(async () => {
                vi.advanceTimersByTime(2001);
            });
            expect(screen.getByText("Cite")).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it("hides the text label when showText=false", () => {
        render(
            <CiteButton
                quoteText="q"
                citationText="c"
                showText={false}
            />,
        );

        expect(screen.queryByText("Cite")).not.toBeInTheDocument();
        expect(screen.getByRole("button")).toBeInTheDocument();
    });

    it("logs but does not throw when the clipboard write fails", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        clipboardWriteText.mockRejectedValueOnce(new Error("permission denied"));

        render(<CiteButton quoteText="q" citationText="c" />);
        await userEvent.click(screen.getByRole("button"));

        await waitFor(() =>
            expect(errSpy).toHaveBeenCalledWith(
                "Failed to copy citation:",
                expect.any(Error),
            ),
        );
        // Stays in idle state — no false "Copied" flash.
        expect(screen.getByText("Cite")).toBeInTheDocument();
        errSpy.mockRestore();
    });

    it("stops the click event from bubbling to ancestors (so it doesn't open a doc/cite link)", async () => {
        // CiteButtons typically sit inside a clickable citation chip;
        // the .stopPropagation() prevents the wrap-click handler from
        // also firing and (e.g.) opening the source document.
        const ancestorClick = vi.fn();
        render(
            <div onClick={ancestorClick}>
                <CiteButton quoteText="q" citationText="c" />
            </div>,
        );

        await userEvent.click(screen.getByRole("button"));

        expect(ancestorClick).not.toHaveBeenCalled();
    });
});
