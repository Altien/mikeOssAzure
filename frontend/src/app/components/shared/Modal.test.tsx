import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";

describe("Modal", () => {
    it("renders nothing when open=false", () => {
        render(
            <Modal open={false} onClose={() => {}} title="Hidden">
                body
            </Modal>,
        );

        expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    });

    it("renders title, children, and the Close button fires onClose", async () => {
        const onClose = vi.fn();
        render(
            <Modal open onClose={onClose} title="Project details">
                <p>modal body</p>
            </Modal>,
        );

        expect(
            screen.getByRole("heading", { name: "Project details" }),
        ).toBeInTheDocument();
        expect(screen.getByText("modal body")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("clicking the backdrop closes; clicking inside the card does not", async () => {
        const onClose = vi.fn();
        render(
            <Modal open onClose={onClose} title="T">
                <p>inside</p>
            </Modal>,
        );

        await userEvent.click(screen.getByText("inside"));
        expect(onClose).not.toHaveBeenCalled();

        // The backdrop is the fixed full-screen wrapper around the card.
        const backdrop = screen
            .getByRole("heading", { name: "T" })
            .closest(".fixed");
        await userEvent.click(backdrop as HTMLElement);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("providing a primaryAction auto-adds a Cancel action wired to onClose", async () => {
        const onClose = vi.fn();
        const onSave = vi.fn();
        render(
            <Modal
                open
                onClose={onClose}
                title="T"
                primaryAction={{ label: "Save", onClick: onSave }}
            >
                body
            </Modal>,
        );

        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(onSave).toHaveBeenCalledOnce();

        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("cancelAction={false} suppresses the implicit Cancel button", () => {
        render(
            <Modal
                open
                onClose={() => {}}
                title="T"
                primaryAction={{ label: "Save", onClick: () => {} }}
                cancelAction={false}
            >
                body
            </Modal>,
        );

        expect(
            screen.queryByRole("button", { name: "Cancel" }),
        ).not.toBeInTheDocument();
    });

    it("renders breadcrumbs (with separators) instead of the title header", () => {
        render(
            <Modal
                open
                onClose={() => {}}
                title="Should not show"
                breadcrumbs={["Projects", "Acme v Beta"]}
            >
                body
            </Modal>,
        );

        expect(screen.getByText("Projects")).toBeInTheDocument();
        expect(screen.getByText("Acme v Beta")).toBeInTheDocument();
        expect(screen.getByText("›")).toBeInTheDocument();
        expect(screen.queryByText("Should not show")).not.toBeInTheDocument();
    });
});
