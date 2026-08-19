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
        expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
    });

    it("omits aria-pressed when the button is not a toggle", () => {
        render(<TabPillButton>Neutral</TabPillButton>);
        expect(
            screen.getByRole("button", { name: "Neutral" }),
        ).not.toHaveAttribute("aria-pressed");
    });

    it("has a visible keyboard focus ring", () => {
        render(<TabPillButton active>Mine</TabPillButton>);
        expect(screen.getByRole("button", { name: "Mine" })).toHaveClass(
            "focus-visible:ring-2",
        );
    });
});
