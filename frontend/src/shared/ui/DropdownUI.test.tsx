import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "./DropdownUI";

describe("DropdownUI", () => {
    it("uses the floating liquid-glass material for its open menu", () => {
        render(
            <Dropdown open>
                <DropdownTrigger>Options</DropdownTrigger>
                <DropdownContent data-testid="dropdown-content">
                    <DropdownItem>First option</DropdownItem>
                </DropdownContent>
            </Dropdown>,
        );

        expect(screen.getByTestId("dropdown-content")).toHaveClass(
            "liquid-glass-float",
        );
    });
});
