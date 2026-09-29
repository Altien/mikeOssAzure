import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToggleSwitch } from "./toggle-switch";

describe("ToggleSwitch", () => {
    it("renders the checked styling and emits the next value", () => {
        const onCheckedChange = vi.fn();
        const { container } = render(
            <ToggleSwitch checked onCheckedChange={onCheckedChange}>
                Group documents
            </ToggleSwitch>,
        );

        const toggle = screen.getByRole("switch", {
            name: "Group documents",
        });
        const track = container.querySelector(
            '[data-slot="toggle-switch-track"]',
        );
        const thumb = container.querySelector(
            '[data-slot="toggle-switch-thumb"]',
        );

        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(track).toHaveClass("bg-blue-600", "h-5", "w-9");
        expect(thumb).toHaveClass("h-3", "w-3", "left-1", "top-1");

        fireEvent.click(toggle);
        expect(onCheckedChange).toHaveBeenCalledWith(false);
    });
});
