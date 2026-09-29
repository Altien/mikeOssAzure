import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";

// OSS-6: retargeted from dev's shared/Modal to upstream's modals/Modal —
// upstream dropped the `title` prop (the header renders only for
// breadcrumbs) and the implicit Cancel action (cancelAction is explicit).
describe("Modal", () => {
    it("renders nothing when open=false", () => {
        render(
            <Modal open={false} onClose={() => {}} breadcrumbs={["Hidden"]}>
                body
            </Modal>,
        );

        expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    });

    it("renders breadcrumbs (with separators), children, and the Close button fires onClose", async () => {
        const onClose = vi.fn();
        render(
            <Modal
                open
                onClose={onClose}
                breadcrumbs={["Projects", "Acme v Beta"]}
            >
                <p>modal body</p>
            </Modal>,
        );

        expect(screen.getByText("Projects")).toBeInTheDocument();
        expect(screen.getByText("Acme v Beta")).toBeInTheDocument();
        expect(screen.getByText("›")).toBeInTheDocument();
        expect(screen.getByText("modal body")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("clicking the backdrop closes; clicking inside the card does not", async () => {
        const onClose = vi.fn();
        render(
            <Modal open onClose={onClose}>
                <p>inside</p>
            </Modal>,
        );

        await userEvent.click(screen.getByText("inside"));
        expect(onClose).not.toHaveBeenCalled();

        // The backdrop is the fixed full-screen wrapper around the card.
        const backdrop = screen.getByText("inside").closest(".fixed");
        await userEvent.click(backdrop as HTMLElement);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("renders primary and explicit cancel actions and fires their handlers", async () => {
        const onCancel = vi.fn();
        const onSave = vi.fn();
        render(
            <Modal
                open
                onClose={() => {}}
                primaryAction={{ label: "Save", onClick: onSave }}
                cancelAction={{ label: "Cancel", onClick: onCancel }}
            >
                body
            </Modal>,
        );

        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(onSave).toHaveBeenCalledOnce();

        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("does not add an implicit Cancel button", () => {
        render(
            <Modal
                open
                onClose={() => {}}
                primaryAction={{ label: "Save", onClick: () => {} }}
            >
                body
            </Modal>,
        );

        expect(
            screen.queryByRole("button", { name: "Cancel" }),
        ).not.toBeInTheDocument();
    });

    it("keepMounted keeps closed content in the DOM, hidden", () => {
        render(
            <Modal open={false} keepMounted onClose={() => {}}>
                <p>kept</p>
            </Modal>,
        );

        const kept = screen.getByText("kept");
        expect(kept.closest(".fixed")).toHaveClass("hidden");
    });
});
