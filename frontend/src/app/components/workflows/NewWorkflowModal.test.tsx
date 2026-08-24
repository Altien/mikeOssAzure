import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";

const workflow = {
    id: "workflow-1",
    is_owner: true,
    metadata: {
        title: "Contract Intake",
        type: "assistant",
        language: "English",
        practice: "Litigation",
        jurisdictions: ["Singapore"],
    },
} as Workflow;

describe("NewWorkflowModal editing", () => {
    it("disables Save until details change", () => {
        render(
            <NewWorkflowModal
                open
                editWorkflow={workflow}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                onUpdated={vi.fn()}
            />,
        );

        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();

        const title = screen.getByLabelText("Title");
        fireEvent.change(title, { target: { value: "Contract Review" } });
        expect(save).toBeEnabled();

        fireEvent.change(title, { target: { value: "Contract Intake" } });
        expect(save).toBeDisabled();
    });
});
