import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GlassIconButton } from "./glass-icon-button";

describe("GlassIconButton", () => {
    it("exposes the required accessible name", () => {
        render(
            <GlassIconButton aria-label="Close">
                <svg />
            </GlassIconButton>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    it("defaults to type=button so it never submits a form", () => {
        render(
            <GlassIconButton aria-label="Close">
                <svg />
            </GlassIconButton>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute(
            "type",
            "button",
        );
    });

    it("carries the shared glass surface classes", () => {
        render(
            <GlassIconButton aria-label="Close">
                <svg />
            </GlassIconButton>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
            "h-7",
            "w-7",
            "rounded-full",
            "liquid-glass-subtle",
            "liquid-glass-hover",
            "backdrop-blur-xl",
        );
    });

    it("has a visible keyboard focus ring", () => {
        render(
            <GlassIconButton aria-label="Close">
                <svg />
            </GlassIconButton>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
            "focus-visible:ring-2",
        );
    });

    it("lets callers override classes without losing the base", () => {
        render(
            <GlassIconButton aria-label="Close" className="ml-auto">
                <svg />
            </GlassIconButton>,
        );
        const button = screen.getByRole("button", { name: "Close" });
        expect(button).toHaveClass("ml-auto", "rounded-full");
    });

    it("fires onClick when activated", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <GlassIconButton aria-label="Close" onClick={onClick}>
                <svg />
            </GlassIconButton>,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
