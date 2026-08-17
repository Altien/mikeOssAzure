import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditCardUI } from "./EditCardUI";

describe("EditCardUI", () => {
    it("renders normalized edit content and delegates every action", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();
        const onAccept = vi.fn();
        const onReject = vi.fn();

        render(
            <EditCardUI
                originalText="old text"
                replacementText="new text"
                reason="Use the defined term."
                changeNumber={2}
                status="pending"
                className="test-surface"
                viewAction={{ label: "View", onClick: onView }}
                acceptAction={{ label: "Accept", onClick: onAccept }}
                rejectAction={{ label: "Reject", onClick: onReject }}
            />,
        );

        expect(screen.getByLabelText("Tracked change 2")).toHaveTextContent(
            "2",
        );
        expect(screen.getByText("new text")).toHaveClass("text-green-700");
        expect(screen.getByText("old text")).toHaveClass(
            "text-red-600",
            "line-through",
        );
        expect(screen.getByText("Use the defined term.")).toHaveClass(
            "font-serif",
            "text-sm",
        );
        expect(
            screen.getAllByRole("button").map((button) => button.textContent),
        ).toEqual(["Accept", "Reject", "View"]);

        await user.click(screen.getByRole("button", { name: "View" }));
        await user.click(screen.getByRole("button", { name: "Accept" }));
        await user.click(screen.getByRole("button", { name: "Reject" }));

        expect(onView).toHaveBeenCalledOnce();
        expect(onAccept).toHaveBeenCalledOnce();
        expect(onReject).toHaveBeenCalledOnce();
    });

    it("supports Word-style status output and disabled actions", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();

        const { container } = render(
            <EditCardUI
                status="view-only"
                statusMessage="Tracked change found — review it in Word."
                statusMessageClassName="text-gray-500"
                ariaBusy
                actionOrder="view-first"
                viewAction={{
                    label: "View",
                    onClick: onView,
                    disabled: true,
                }}
            />,
        );

        expect(container.firstChild).toHaveAttribute(
            "data-edit-status",
            "view-only",
        );
        expect(container.firstChild).toHaveAttribute("aria-busy", "true");
        expect(screen.getByRole("status")).toHaveClass("text-gray-500");

        await user.click(screen.getByRole("button", { name: "View" }));
        expect(onView).not.toHaveBeenCalled();
    });
});
