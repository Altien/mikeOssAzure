import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Citation } from "../shared/types";
import { AssistantMessage } from "./AssistantMessage";

// OSS-6: upstream's AssistantMessage takes `citations` (was `annotations`)
// and renders from `events` only (no `content` prop).
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
        } as unknown as Citation;

        renderWithProviders(
            <AssistantMessage
                citations={[legacyCitation]}
                citationStatus="final"
            />,
        );

        expect(screen.getByText("Document citation")).toBeInTheDocument();
    });
});

describe("AssistantMessage Authority Trace", () => {
    it("renders a stable extraction result and its warnings", () => {
        renderWithProviders(
            <AssistantMessage
                events={[
                    {
                        type: "authority_trace_extraction",
                        outcome: "success",
                        document_id: "doc-id",
                        version_id: "version-id",
                        document_handle: "doc-3",
                        filename: "opinion.verification.md",
                        page_count: 4,
                        warnings: ["ocr_required"],
                    },
                ]}
            />,
        );

        expect(
            screen.getByText("Verification document extracted"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "opinion.verification.md · doc-3 · ocr required",
            ),
        ).toBeInTheDocument();
    });

    it("renders a compact completed verification summary", () => {
        const onOpen = vi.fn();
        renderWithProviders(
            <AssistantMessage
                onAuthorityTraceOpen={onOpen}
                events={[
                    {
                        type: "authority_trace_verification",
                        run_id: "run-1",
                        outcome: "completed_with_failures",
                        total: 3,
                        anchored: 2,
                        failed: 1,
                        exact: 1,
                        formatting_different: 1,
                        no_quote_claimed: 0,
                        warning_count: 1,
                        diagnostics: ["c003: ambiguous in memo"],
                    },
                ]}
            />,
        );

        expect(
            screen.getByText("Authority Trace completed with failures"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "1 exact · 1 formatting differs · 1 failed · 1 warnings · c003: ambiguous in memo",
            ),
        ).toBeInTheDocument();
        const openReview = screen.getByRole("button", {
            name: /Authority Trace completed with failures.*Open review/,
        });
        expect(openReview).toHaveClass("cursor-pointer");
        fireEvent.click(openReview);
        expect(onOpen).toHaveBeenCalledWith("run-1");
    });

    it("renders fatal verification errors without claiming a completed run", () => {
        renderWithProviders(
            <AssistantMessage
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

    it("renders extraction prerequisites without labelling them fatal", () => {
        renderWithProviders(
            <AssistantMessage
                events={[
                    {
                        type: "authority_trace_verification",
                        outcome: "action_required",
                        total: 0,
                        anchored: 0,
                        failed: 0,
                        error: "Call extract_document_for_verification first",
                    },
                ]}
            />,
        );

        expect(
            screen.getByText("Authority Trace needs document extraction"),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Call extract_document_for_verification first"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Authority Trace failed"),
        ).not.toBeInTheDocument();
    });
});
