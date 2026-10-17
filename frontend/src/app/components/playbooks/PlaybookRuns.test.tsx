import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookRun } from "@/app/lib/mikeApi";
import { PlaybookRuns } from "./PlaybookRuns";

const api = vi.hoisted(() => ({
  listPlaybookRuns: vi.fn(),
  resolveDocumentEdit: vi.fn(),
}));
const viewer = vi.hoisted(() => ({ docx: vi.fn() }));
// The real viewer lazy-loads a Word renderer that jsdom cannot run.
vi.mock("@/app/components/shared/views/DocxView", () => ({
  DocxView: (props: { documentId: string; refetchKey?: number }) => {
    viewer.docx(props);
    return (
      <div
        role="document"
        aria-label={`Document ${props.documentId}, revision ${props.refetchKey}`}
      />
    );
  },
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  ...api,
}));

function run(overrides: Partial<PlaybookRun> = {}): PlaybookRun {
  return {
    id: "run-1",
    playbookId: "pb",
    model: "claude-opus-5-5",
    documentName: "Supply agreement.docx",
    reviewMode: "strict",
    status: "completed",
    summary: "One uncapped indemnity.",
    findings: [
      {
        id: "f-1",
        topicId: null,
        ruleId: "cap",
        ruleName: "Liability cap",
        status: "unacceptable",
        quote: "Liability is unlimited.",
        location: "Clause 9",
        analysis: "The cap is missing.",
        suggestedText: "Liability is capped at fees paid.",
      },
      {
        id: "f-2",
        topicId: null,
        ruleId: "law",
        ruleName: "Governing law",
        status: "needs_review",
        quote: "",
        location: "",
        analysis: "Unclear.",
        suggestedText: "",
      },
    ],
    error: null,
    startedAt: "2026-10-17T09:00:00.000Z",
    completedAt: "2026-10-17T09:01:00.000Z",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("playbook runs", () => {
  it("shows a reviewed Word document beside its results and decides its tracked changes", async () => {
    const edit = {
      kind: "edit" as const,
      edit_id: "e1",
      document_id: "doc-1",
      version_id: "v2",
      version_number: 2,
      change_id: "c1",
      deleted_text: "unlimited",
      inserted_text: "capped at fees paid",
      context_before: "Liability is ",
      context_after: ".",
      status: "pending" as const,
    };
    const reviewed = run();
    api.listPlaybookRuns.mockResolvedValue([
      {
        ...reviewed,
        documentId: "doc-1",
        editedVersionId: "v2",
        findings: [{ ...reviewed.findings[0], edit }],
      },
    ]);
    api.resolveDocumentEdit.mockResolvedValue({
      ok: true,
      status: "accepted",
      version_id: "v3",
      download_url: null,
    });
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} canRun onRun={vi.fn()} />,
    );

    // The document sits between the runs and the results.
    const pane = await screen.findByRole("region", { name: "Reviewed document" });
    expect(screen.getByRole("separator", { name: "Resize runs panel" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize run results panel" })).toBeInTheDocument();
    expect(
      within(pane).getByRole("document", { name: "Document doc-1, revision 0" }),
    ).toBeInTheDocument();
    // A change in the document is decided from an edit card.
    const issues = screen.getByRole("region", { name: /Issues/ });
    expect(within(issues).getByText("Recommended change")).toBeVisible();
    expect(within(issues).queryByText("Recommended changes")).toBeNull();

    await userEvent.click(within(issues).getByRole("button", { name: "Accept" }));

    expect(api.resolveDocumentEdit).toHaveBeenCalledWith("doc-1", "e1", "accept");
    // The document reloads to show the change accepted.
    expect(
      await within(pane).findByRole("document", {
        name: "Document doc-1, revision 1",
      }),
    ).toBeInTheDocument();
  });


  it("lists past runs with their outcome and shows the selected run's findings", async () => {
    api.listPlaybookRuns.mockResolvedValue([
      run(),
      run({
        id: "run-0",
        documentName: "Old NDA.pdf",
        summary: "Nothing to change.",
        findings: [],
        startedAt: "2026-10-16T09:00:00.000Z",
      }),
    ]);
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} canRun onRun={vi.fn()} />,
    );
    const list = screen.getByRole("region", { name: "Your runs" });
    const latest = await within(list).findByRole("button", {
      name: /Supply agreement\.docx/,
    });
    expect(latest).toHaveAttribute("aria-pressed", "true");
    // One line per run: the document alone, without the outcome.
    expect(latest).toHaveTextContent(/^Supply agreement\.docx$/);
    expect(api.listPlaybookRuns).toHaveBeenCalledWith("pb");
    const results = screen.getByRole("region", { name: "Run results" });
    // Findings are grouped by urgency, each in its own card.
    const issues = within(results).getByRole("region", { name: /Issues/ });
    expect(within(issues).getByText("Liability cap")).toBeVisible();
    expect(within(issues).getByText("Unacceptable")).toBeVisible();
    expect(within(issues).getByText("Clause 9")).toBeVisible();
    // Each part of a finding says what it is.
    for (const label of ["Where", "Assessment", "Recommended changes"])
      expect(within(issues).getByText(label)).toBeVisible();
    // The recommendation is a redline of the contract language.
    const removed = issues.querySelector("del");
    const added = issues.querySelector("ins");
    expect(removed).toHaveTextContent("Removed: unlimited");
    expect(added).toHaveTextContent("Added: capped at fees paid");
    expect(within(issues).queryByText("Contract language")).toBeNull();
    const toReview = within(results).getByRole("region", {
      name: /Needs review/,
    });
    expect(within(toReview).getByText("Governing law")).toBeVisible();
    expect(
      within(results).queryByRole("region", { name: /Acceptable/ }),
    ).toBeNull();

    await userEvent.click(
      within(list).getByRole("button", { name: /Old NDA\.pdf/ }),
    );

    expect(within(results).getByText("Nothing to change.")).toBeVisible();
    expect(within(results).getByText("No findings.")).toBeVisible();
  });

  it("selects a run finished on the page before the history loads", async () => {
    api.listPlaybookRuns.mockResolvedValue([
      run({ id: "run-0", documentName: "Older.docx" }),
    ]);
    render(
      <PlaybookRuns
        playbookId="pb"
        latestRun={run({ id: "run-new", documentName: "Fresh.docx" })}
        canRun
        onRun={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Fresh\.docx/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Older\.docx/ })).toBeVisible();
  });

  it("refreshes history when a batch completes while the Runs tab is already open", async () => {
    api.listPlaybookRuns.mockResolvedValue([]);
    const { rerender } = render(
      <PlaybookRuns playbookId="pb" latestRun={null} canRun onRun={vi.fn()} />,
    );
    await screen.findByText("None yet.");
    const first = run({ id: "batch-1", documentName: "First.txt" });
    const second = run({ id: "batch-2", documentName: "Second.txt" });
    api.listPlaybookRuns.mockResolvedValue([second, first]);
    rerender(
      <PlaybookRuns
        playbookId="pb"
        latestRun={second}
        canRun
        onRun={vi.fn()}
      />,
    );
    const list = screen.getByRole("region", { name: "Your runs" });
    expect(
      await within(list).findByRole("button", { name: "First.txt" }),
    ).toBeVisible();
    expect(
      within(list).getByRole("button", { name: "Second.txt" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(api.listPlaybookRuns).toHaveBeenCalledTimes(2);
  });

  it("offers a run when there are none yet", async () => {
    api.listPlaybookRuns.mockResolvedValue([]);
    const onRun = vi.fn();
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} canRun onRun={onRun} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Run" }));

    expect(onRun).toHaveBeenCalled();
    expect(screen.getByText("None yet.")).toBeVisible();
  });

  it("shows a failed run's error and retries a failed load", async () => {
    api.listPlaybookRuns
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([
        run({ error: "The model timed out.", findings: [] }),
      ]);
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} canRun onRun={vi.fn()} />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Try again" }),
    );

    expect(
      await screen.findByRole("button", { name: /Supply agreement/ }),
    ).toBeVisible();
    expect(screen.getByText("The model timed out.")).toBeVisible();
  });
});
