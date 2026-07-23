import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WarningPopup } from "./WarningPopup";

describe("WarningPopup", () => {
    it("renders nothing when open=false", () => {
        render(
            <WarningPopup open={false} onClose={() => {}} title="T" message="M" />,
        );

        expect(screen.queryByText("T")).not.toBeInTheDocument();
    });

    it("renders title, message, and children when open", () => {
        render(
            <WarningPopup open onClose={() => {}} title="Heads up" message="Body copy">
                <div>extra child</div>
            </WarningPopup>,
        );

        expect(screen.getByText("Heads up")).toBeInTheDocument();
        expect(screen.getByText("Body copy")).toBeInTheDocument();
        expect(screen.getByText("extra child")).toBeInTheDocument();
    });

    it("the X button (aria-label 'Dismiss warning') fires onClose", async () => {
        const onClose = vi.fn();
        render(<WarningPopup open onClose={onClose} message="M" />);

        await userEvent.click(
            screen.getByRole("button", { name: "Dismiss warning" }),
        );

        expect(onClose).toHaveBeenCalledOnce();
    });

    it("renders primary and secondary actions and fires their handlers", async () => {
        const onPrimary = vi.fn();
        const onSecondary = vi.fn();
        render(
            <WarningPopup
                open
                onClose={() => {}}
                message="M"
                primaryAction={{ label: "Fix it", onClick: onPrimary }}
                secondaryAction={{ label: "Later", onClick: onSecondary }}
            />,
        );

        await userEvent.click(screen.getByRole("button", { name: "Fix it" }));
        await userEvent.click(screen.getByRole("button", { name: "Later" }));

        expect(onPrimary).toHaveBeenCalledOnce();
        expect(onSecondary).toHaveBeenCalledOnce();
    });

    it("a disabled action cannot fire", async () => {
        const onPrimary = vi.fn();
        render(
            <WarningPopup
                open
                onClose={() => {}}
                message="M"
                primaryAction={{ label: "Fix it", onClick: onPrimary, disabled: true }}
            />,
        );

        const button = screen.getByRole("button", { name: "Fix it" });
        expect(button).toBeDisabled();
        await userEvent.click(button).catch(() => {});
        expect(onPrimary).not.toHaveBeenCalled();
    });
});
