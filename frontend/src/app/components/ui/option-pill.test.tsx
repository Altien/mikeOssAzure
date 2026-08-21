import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OptionPill } from "./option-pill";

describe("OptionPill", () => {
    it("renders a compact white option without action-button styling", () => {
        render(<OptionPill>Litigation</OptionPill>);

        const option = screen.getByRole("button", { name: "Litigation" });
        expect(option).toHaveAttribute("data-slot", "option-pill");
        expect(option).toHaveClass("rounded-full", "bg-white", "text-xs");
    });
});
