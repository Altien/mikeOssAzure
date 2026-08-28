import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "../shared/types";
import { WorkflowReferenceFiles } from "./WorkflowReferenceFiles";

const { listWorkflowReferenceFiles } = vi.hoisted(() => ({
    listWorkflowReferenceFiles: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...actual,
        listWorkflowReferenceFiles,
    };
});

vi.mock("../shared/DocumentSidePanel", () => ({
    DocumentSidePanel: ({ doc }: { doc: Document | null }) =>
        doc ? (
            <div data-testid="document-side-panel">{doc.filename}</div>
        ) : null,
}));

describe("WorkflowReferenceFiles", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listWorkflowReferenceFiles.mockResolvedValue([
            {
                id: "reference-1",
                workflow_id: "workflow-1",
                filename: "Precedent.docx",
                file_type: "docx",
                size_bytes: 42,
                created_at: "2026-08-28T00:00:00.000Z",
                updated_at: "2026-08-28T00:00:00.000Z",
            },
        ]);
    });

    it("opens a reference file in the document side panel when its row is clicked", async () => {
        const user = userEvent.setup();
        render(
            <WorkflowReferenceFiles workflowId="workflow-1" readOnly={false} />,
        );

        await waitFor(() =>
            expect(screen.getByText("Precedent.docx")).toBeVisible(),
        );
        await user.click(screen.getByText("Precedent.docx"));

        expect(screen.getByTestId("document-side-panel")).toHaveTextContent(
            "Precedent.docx",
        );
    });
});
