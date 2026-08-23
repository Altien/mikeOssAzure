import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabPillButton } from "./tab-pill-button";

describe("TabPillButton", () => {
    it("defaults to type=button", () => {
        render(<TabPillButton>All</TabPillButton>);
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
            "type",
            "button",
        );
    });

    it("reports its selected state to assistive tech", () => {
        render(<TabPillButton active>Mine</TabPillButton>);
        const button = screen.getByRole("button", { name: "Mine" });
        expect(button).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(button).toHaveClass(
            "border-white/80",
            "bg-white",
            "text-gray-900",
        );
        expect(button).not.toHaveClass("liquid-glass-selected");
    });

    it("omits aria-pressed when the button is not a toggle", () => {
        render(<TabPillButton>Neutral</TabPillButton>);
        const button = screen.getByRole("button", { name: "Neutral" });
        expect(button).not.toHaveAttribute("aria-pressed");
        expect(button).toHaveClass("liquid-glass-hover");
    });

    it("has a visible keyboard focus ring", () => {
        render(<TabPillButton active>Mine</TabPillButton>);
        expect(screen.getByRole("button", { name: "Mine" })).toHaveClass(
            "liquid-glass-subtle",
            "focus-visible:ring-2",
        );
    });
});
