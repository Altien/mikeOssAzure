import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";

const { getRunMock, saveReviewMock } = vi.hoisted(() => ({
    getRunMock: vi.fn(),
    saveReviewMock: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getAuthorityTraceRun: getRunMock,
    saveAuthorityTraceReview: saveReviewMock,
}));

import { AuthorityTracePanel } from "./AuthorityTracePanel";

const citation = {
    id: "c001",
    source_candidates: ["authority"],
    cite_text: "Example v Example",
    proposition: "The rule applies.",
    support_type: "quotation" as const,
    status: "anchored" as const,
    binds_to: "a".repeat(64),
    warnings: [],
    memo_anchor: {
        start: 0,
        end: 17,
        quote: "Example v Example",
        match: "exact" as const,
        warnings: [],
    },
    anchors: [
        {
            source: "authority",
            quote: "The rule applies.",
            start: 0,
            end: 17,
            match: "normalized" as const,
            warnings: [],
        },
    ],
};

function workspace() {
    return {
        id: "run-1",
        project_id: "project-1",
        created_at: "2026-07-25T12:00:00.000Z",
        verified_record: {
            citations: [
                citation,
                {
                    ...citation,
                    id: "c002",
                    cite_text: "Missing authority",
                    status: "anchor_failed" as const,
                    failure_reason: "source_missing",
                    binds_to: "b".repeat(64),
                    memo_anchor: null,
                    anchors: [],
                },
                {
                    ...citation,
                    id: "c003",
                    cite_text: "No quotation",
                    status: "no_quote_claimed" as const,
                    binds_to: "c".repeat(64),
                    anchors: [],
                },
            ],
        },
        report: {
            outcome: "completed_with_failures" as const,
            total: 3,
            anchored: 1,
            failed: 1,
            no_quote_claimed: 1,
            exact: 0,
            formatting_different: 1,
        },
        memo: {
            document_id: "memo-id",
            version_id: "memo-v1",
            filename: "memo.md",
            available: true,
            segments: [
                { text: "Example v Example", highlights: ["c001"] },
                { text: " context", highlights: [] },
            ],
        },
        sources: {
            authority: {
                document_id: "source-id",
                version_id: "source-v1",
                filename: "source.md",
                title: "Authority",
                kind: "case",
                available: true,
                segments: [
                    { text: "The rule applies.", highlights: ["c001"] },
                    { text: " More.", highlights: [] },
                ],
            },
        },
        reviews: [],
        current_reviews: {},
    };
}

beforeEach(() => {
    getRunMock.mockReset().mockResolvedValue(workspace());
    saveReviewMock.mockReset().mockResolvedValue({
        id: "review-1",
        verdict: "verified",
    });
});

describe("AuthorityTracePanel", () => {
    it("renders formatting, failure, missing, and no-quote states without browser offset math", async () => {
        renderWithProviders(<AuthorityTracePanel runId="run-1" />);

        expect(await screen.findByText("Formatting differs")).toBeInTheDocument();
        expect(screen.getByText("Source missing")).toBeInTheDocument();
        expect(screen.getByText("No quote claimed")).toBeInTheDocument();
        expect(
            screen
                .getAllByText("Example v Example")
                .some((node) => node.tagName === "MARK"),
        ).toBe(true);
        expect(
            screen
                .getAllByText("The rule applies.")
                .some((node) => node.tagName === "MARK"),
        ).toBe(true);
    });

    it("navigates with arrows and does not steal verdict keys from the note", async () => {
        renderWithProviders(<AuthorityTracePanel runId="run-1" />);
        await screen.findByText("Formatting differs");

        fireEvent.keyDown(window, { key: "ArrowDown" });
        expect(
            screen.getByLabelText("2 of 3 citations"),
        ).toBeInTheDocument();

        const note = screen.getByLabelText("Review note");
        fireEvent.change(note, { target: { value: "v" } });
        fireEvent.keyDown(note, { key: "v" });
        expect(saveReviewMock).not.toHaveBeenCalled();
    });

    it("saves an append-only verdict with the current binding and note", async () => {
        renderWithProviders(<AuthorityTracePanel runId="run-1" />);
        await screen.findByText("Formatting differs");

        fireEvent.change(screen.getByLabelText("Review note"), {
            target: { value: "Checked against source" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Verified (V)" }));

        await waitFor(() =>
            expect(saveReviewMock).toHaveBeenCalledWith("run-1", {
                citation_id: "c001",
                binds_to: "a".repeat(64),
                verdict: "verified",
                note: "Checked against source",
            }),
        );
    });
});
