import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmPopup } from "./ConfirmPopup";

describe("ConfirmPopup", () => {
    it("renders nothing when open=false", () => {
        render(
            <ConfirmPopup
                open={false}
                title="Sure?"
                onConfirm={() => {}}
                onCancel={() => {}}
            />,
        );

        expect(screen.queryByText("Sure?")).not.toBeInTheDocument();
    });

    it("fires onConfirm / onCancel from their buttons", async () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(
            <ConfirmPopup
                open
                title="Delete this project?"
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        await userEvent.click(screen.getByRole("button", { name: /Confirm/ }));
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onConfirm).toHaveBeenCalledOnce();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("loading state: shows the progressive label, sets aria-busy, and disables confirm", () => {
        render(
            <ConfirmPopup
                open
                confirmLabel="Delete"
                confirmStatus="loading"
                onConfirm={() => {}}
                onCancel={() => {}}
            />,
        );

        const button = screen.getByRole("button", { name: /Deleting/ });
        expect(button).toHaveAttribute("aria-busy", "true");
        expect(button).toBeDisabled();
        expect(screen.getByText("Deleting...")).toBeInTheDocument();
    });

    it("complete state: shows the past-tense label and stays disabled", () => {
        render(
            <ConfirmPopup
                open
                confirmLabel="Delete"
                confirmStatus="complete"
                onConfirm={() => {}}
                onCancel={() => {}}
            />,
        );

        const button = screen.getByRole("button", { name: "Deleted" });
        expect(button).toBeDisabled();
    });

    it("confirmDisabled blocks the action even in idle state", async () => {
        const onConfirm = vi.fn();
        render(
            <ConfirmPopup
                open
                confirmDisabled
                onConfirm={onConfirm}
                onCancel={() => {}}
            />,
        );

        const button = screen.getByRole("button", { name: "Confirm" });
        expect(button).toBeDisabled();
        await userEvent.click(button).catch(() => {});
        expect(onConfirm).not.toHaveBeenCalled();
    });
});
