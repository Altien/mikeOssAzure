import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "./input";

describe("Input", () => {
    it("renders a controlled value through to the DOM", () => {
        render(<Input value="hello" onChange={() => {}} />);

        const input = screen.getByRole("textbox") as HTMLInputElement;
        expect(input.value).toBe("hello");
        expect(input).toHaveAttribute("data-slot", "input");
    });

    it("calls onChange when the user types", async () => {
        let captured = "";
        function Probe() {
            return (
                <Input
                    value={captured}
                    onChange={(e) => {
                        captured = e.target.value;
                    }}
                />
            );
        }

        render(<Probe />);
        await userEvent.type(screen.getByRole("textbox"), "hi");

        expect(captured).toBe("i");
    });

    it("does not accept input when disabled", async () => {
        let captured = "untouched";
        render(
            <Input
                disabled
                value={captured}
                onChange={(e) => {
                    captured = e.target.value;
                }}
            />,
        );

        await userEvent.type(screen.getByRole("textbox"), "abc");

        expect(captured).toBe("untouched");
        expect(screen.getByRole("textbox")).toBeDisabled();
    });

    it("forwards type='email' to the underlying input", () => {
        // <input type="email"> isn't role=textbox by default; it
        // exposes role=textbox only when not validated. The DOM
        // assertion is the reliable contract.
        render(<Input type="email" placeholder="email" />);

        const input = document.querySelector<HTMLInputElement>(
            "input[data-slot='input']",
        );
        expect(input?.type).toBe("email");
    });

    it("reflects aria-invalid for form-level error states", () => {
        render(<Input aria-invalid="true" />);

        expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    });
});
