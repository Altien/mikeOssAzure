import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { CitationAnnotation } from "../shared/types";
import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage citations", () => {
    it("renders a legacy document citation without a filename", () => {
        const legacyCitation = {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            document_id: "doc-1",
            page: 1,
            quote: "Legacy citation text",
        } as unknown as CitationAnnotation;

        renderWithProviders(
            <AssistantMessage
                content=""
                annotations={[legacyCitation]}
                citationStatus="final"
            />,
        );

        expect(screen.getByText("Document citation")).toBeInTheDocument();
    });
});

describe("AssistantMessage Authority Trace", () => {
    it("renders a compact completed verification summary", () => {
        renderWithProviders(
            <AssistantMessage
                content=""
                events={[
                    {
                        type: "authority_trace_verification",
                        run_id: "run-1",
                        outcome: "completed_with_failures",
                        total: 3,
                        anchored: 2,
                        failed: 1,
                    },
                ]}
            />,
        );

        expect(
            screen.getByText("Authority Trace completed with failures"),
        ).toBeInTheDocument();
        expect(screen.getByText("2 anchored · 1 failed")).toBeInTheDocument();
    });

    it("renders fatal verification errors without claiming a completed run", () => {
        renderWithProviders(
            <AssistantMessage
                content=""
                events={[
                    {
                        type: "authority_trace_verification",
                        outcome: "fatal",
                        total: 0,
                        anchored: 0,
                        failed: 0,
                        error: "Invalid proposal",
                    },
                ]}
            />,
        );

        expect(screen.getByText("Authority Trace failed")).toBeInTheDocument();
        expect(screen.getByText("Invalid proposal")).toBeInTheDocument();
    });
});
