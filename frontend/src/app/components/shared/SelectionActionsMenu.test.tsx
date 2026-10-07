import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionActionsMenu } from "./SelectionActionsMenu";

describe("SelectionActionsMenu", () => {
    it("opens from the Actions button and runs the chosen action", async () => {
        const user = userEvent.setup();
        const onDownload = vi.fn();
        const onDelete = vi.fn();
        render(
            <SelectionActionsMenu
                actions={[
                    { label: "Download", onSelect: onDownload },
                    { label: "Delete", destructive: true, onSelect: onDelete },
                ]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Actions" }));
        expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass(
            "text-red-600",
        );
        await user.click(screen.getByRole("menuitem", { name: "Download" }));

        expect(onDownload).toHaveBeenCalledOnce();
        expect(onDelete).not.toHaveBeenCalled();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("does not run a disabled action", async () => {
        const user = userEvent.setup();
        const onClear = vi.fn();
        render(
            <SelectionActionsMenu
                actions={[
                    { label: "Clear results", disabled: true, onSelect: onClear },
                ]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Actions" }));
        const item = screen.getByRole("menuitem", { name: "Clear results" });
        expect(item).toHaveAttribute("aria-disabled", "true");
        await user.click(item);

        expect(onClear).not.toHaveBeenCalled();
    });
});
