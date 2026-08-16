import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PreResponseWrapperUI } from "./PreResponseWrapperUI";

describe("PreResponseWrapperUI", () => {
    it("shows streaming activity and lets the user collapse it", async () => {
        const user = userEvent.setup();

        render(
            <PreResponseWrapperUI
                stepCount={2}
                shouldMinimize={false}
                isStreaming
            >
                <div>Reading document</div>
            </PreResponseWrapperUI>,
        );

        const toggle = screen.getByRole("button", { name: "Working" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(toggle).toHaveClass("text-sm");
        expect(screen.getByText("Reading document").parentElement).toHaveClass(
            "gap-4",
        );

        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Reading document")).toBeNull();
    });

    it("renders a minimized completion summary and supports forceOpen", async () => {
        const { rerender } = render(
            <PreResponseWrapperUI
                stepCount={1}
                shouldMinimize
                isStreaming={false}
            >
                <div>Read agreement</div>
            </PreResponseWrapperUI>,
        );

        expect(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        ).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Read agreement")).toBeNull();

        rerender(
            <PreResponseWrapperUI
                stepCount={1}
                shouldMinimize
                isStreaming={false}
                forceOpen
            >
                <div>Read agreement</div>
            </PreResponseWrapperUI>,
        );

        expect(await screen.findByText("Read agreement")).toBeVisible();
    });
});
