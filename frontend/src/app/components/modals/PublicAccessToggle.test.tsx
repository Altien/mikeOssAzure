import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PublicAccessToggle } from "./PublicAccessToggle";

describe("PublicAccessToggle", () => {
    it("is off for a private item, and says who can open it", () => {
        render(
            <PublicAccessToggle
                visibility="private"
                onChange={vi.fn()}
                organizationName="Elite Law LLP"
                resourceNoun="project"
            />,
        );
        const toggle = screen.getByRole("switch", { name: "Public" });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(toggle).toHaveAccessibleDescription(
            "Private. Only the people you share this project with can open it.",
        );
    });

    it("is on for a public item, and names the organisation it is open to", () => {
        render(
            <PublicAccessToggle
                visibility="organization"
                onChange={vi.fn()}
                organizationName="Elite Law LLP"
                resourceNoun="workflow"
            />,
        );
        const toggle = screen.getByRole("switch", { name: "Public" });
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(toggle).toHaveAccessibleDescription(
            "Everyone in Elite Law LLP can open and edit this workflow.",
        );
    });

    it("reports the other setting when switched", () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <PublicAccessToggle
                visibility="private"
                onChange={onChange}
                resourceNoun="project"
            />,
        );
        fireEvent.click(screen.getByRole("switch", { name: "Public" }));
        expect(onChange).toHaveBeenLastCalledWith("organization");

        rerender(
            <PublicAccessToggle
                visibility="organization"
                onChange={onChange}
                resourceNoun="project"
            />,
        );
        fireEvent.click(screen.getByRole("switch", { name: "Public" }));
        expect(onChange).toHaveBeenLastCalledWith("private");
    });

    it("still reads sensibly before the organisation's name is known", () => {
        render(
            <PublicAccessToggle
                visibility="organization"
                onChange={vi.fn()}
                resourceNoun="project"
            />,
        );
        expect(
            screen.getByText(
                "Everyone in the organisation can open and edit this project.",
            ),
        ).toBeInTheDocument();
    });

    it("can be shown without being changeable", () => {
        const onChange = vi.fn();
        render(
            <PublicAccessToggle
                visibility="organization"
                onChange={onChange}
                resourceNoun="workflow"
                disabled
            />,
        );
        const toggle = screen.getByRole("switch", { name: "Public" });
        expect(toggle).toBeDisabled();
        fireEvent.click(toggle);
        expect(onChange).not.toHaveBeenCalled();
    });
});
