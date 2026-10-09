import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { AuthorityTraceWorkspace } from "./api";

const { downloadExportMock, getRunMock, saveReviewMock } = vi.hoisted(() => ({
    downloadExportMock: vi.fn(),
    getRunMock: vi.fn(),
    saveReviewMock: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./api")>()),
    downloadAuthorityTraceExport: downloadExportMock,
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

function workspace(): AuthorityTraceWorkspace {
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
            integrity: "ok" as const,
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
                integrity: "ok" as const,
                segments: [
                    { text: "The rule applies.", highlights: ["c001"] },
                    { text: " More.", highlights: [] },
                ],
            },
        },
        reviews: [],
        current_reviews: {},
        integrity: {
            ok: true,
            warnings: [],
        },
    };
}

beforeEach(() => {
    getRunMock.mockReset().mockResolvedValue(workspace());
    saveReviewMock.mockReset().mockResolvedValue({
        id: "review-1",
        verdict: "verified",
    });
    downloadExportMock.mockReset().mockResolvedValue(undefined);
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

    it("shows integrity drift and renders only server-supplied unhighlighted segments", async () => {
        const drifted = workspace();
        drifted.sources.authority.integrity = "changed";
        drifted.sources.authority.segments = [
            { text: "Changed source text.", highlights: [] },
        ];
        drifted.integrity = {
            ok: false,
            warnings: [
                {
                    scope: "source",
                    source: "authority",
                    status: "changed",
                    message:
                        "Authority no longer matches this run; highlights are suppressed.",
                },
            ],
        };
        getRunMock.mockResolvedValue(drifted);

        renderWithProviders(<AuthorityTracePanel runId="run-1" />);

        expect(
            await screen.findByText("Integrity check failed"),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Changed source text.").tagName,
        ).toBe("SPAN");
    });

    it("keeps a changed citation's former verdict visible as stale history", async () => {
        const rerun = workspace();
        rerun.reviews = [
            {
                id: "review-old",
                run_id: "run-old",
                citation_id: "c001",
                binds_to: "f".repeat(64),
                verdict: "verified",
                note: "Checked before the citation changed",
                reviewer_user_id: "user-1",
                reviewer_email: "reviewer@example.com",
                created_at: "2026-07-25T10:00:00.000Z",
                stale: true,
            },
        ];
        getRunMock.mockResolvedValue(rerun);

        renderWithProviders(<AuthorityTracePanel runId="run-1" />);

        expect(await screen.findByText("1 stale review")).toBeInTheDocument();
        fireEvent.click(screen.getByText("1 stale review"));
        expect(
            screen.getByText(/Checked before the citation changed/),
        ).toBeInTheDocument();
    });

    it("requires an explicit degraded export when integrity failed", async () => {
        const drifted = workspace();
        drifted.integrity = {
            ok: false,
            warnings: [
                {
                    scope: "memo",
                    status: "changed",
                    message: "Memo changed.",
                },
            ],
        };
        getRunMock.mockResolvedValue(drifted);
        renderWithProviders(<AuthorityTracePanel runId="run-1" />);

        fireEvent.click(
            await screen.findByRole("button", {
                name: "Export degraded audit",
            }),
        );

        await waitFor(() =>
            expect(downloadExportMock).toHaveBeenCalledWith(
                "run-1",
                "audit",
                { forceDegraded: true },
            ),
        );
    });
});
