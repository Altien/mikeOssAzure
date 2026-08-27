import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
    it("renders a high-contrast blue primary action", () => {
        render(
            <Modal
                open
                onClose={() => {}}
                primaryAction={{ label: "Import and compile", variant: "blue" }}
            >
                <p>Import form</p>
            </Modal>,
        );

        expect(
            screen.getByRole("button", { name: "Import and compile" }),
        ).toHaveClass("bg-blue-600/90", "text-white");
    });
});
