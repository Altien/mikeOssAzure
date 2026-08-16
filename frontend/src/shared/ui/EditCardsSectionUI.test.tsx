import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EditCardsSectionUI } from "./EditCardsSectionUI";

describe("EditCardsSectionUI", () => {
    it("renders its summary and actions and toggles the cards", async () => {
        const user = userEvent.setup();

        render(
            <EditCardsSectionUI
                summary="2 tracked changes"
                actions={<button type="button">Accept all</button>}
                className="test-surface"
            >
                <div>First edit</div>
                <div>Second edit</div>
            </EditCardsSectionUI>,
        );

        expect(screen.getByText("2 tracked changes")).toHaveClass("text-sm");
        expect(
            screen.getByRole("group", { name: "Tracked change actions" }),
        ).toBeInTheDocument();
        expect(screen.getByText("First edit")).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Collapse edits" }));
        expect(screen.queryByText("First edit")).toBeNull();
        expect(
            screen.getByRole("button", { name: "Expand edits" }),
        ).toHaveAttribute("aria-expanded", "false");

        await user.click(screen.getByRole("button", { name: "Expand edits" }));
        expect(screen.getByText("Second edit")).toBeVisible();
    });
});
