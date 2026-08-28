import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowList } from "./WorkflowList";

const { setActiveTab, listWorkflowAddons } = vi.hoisted(() => ({
  setActiveTab: vi.fn(),
  listWorkflowAddons: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/hooks/useQueryParamTab", () => ({
  useQueryParamTab: () => ["addons", setActiveTab],
}));

vi.mock("@/app/hooks/usePaginatedWorkflows", () => ({
  usePaginatedWorkflows: () => ({
    dbWorkflows: [],
    setDbWorkflows: vi.fn(),
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    loadMoreError: null,
    loadMore: vi.fn(),
    selectedWorkflowIds: [],
    setSelectedWorkflowIds: vi.fn(),
    selectAllMatching: vi.fn(),
    selectingAll: false,
  }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
  deleteWorkflow: vi.fn(),
  getWorkflowFilterOptions: vi.fn(),
  getWorkflowAddon: vi.fn(),
  importWorkflowAddon: vi.fn(),
  listWorkflowAddons,
}));

vi.mock("./UseWorkflowModal", () => ({
  UseWorkflowModal: () => null,
}));

vi.mock("./NewWorkflowModal", () => ({
  NewWorkflowModal: () => null,
}));

vi.mock("./WorkflowAddonPreviewModal", () => ({
  WorkflowAddonPreviewModal: () => null,
}));

describe("WorkflowList pack toolbar", () => {
  beforeEach(() => {
    setActiveTab.mockReset();
    listWorkflowAddons.mockReset();
    listWorkflowAddons.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });

  it("replaces workflow tabs with Back on the left inside a pack", async () => {
    const user = userEvent.setup();
    render(<WorkflowList initialTab="addons" packKey="legal-starter" />);

    const back = screen.getByText("Back").closest("button");
    expect(back).not.toBeNull();
    if (!back) throw new Error("Pack toolbar Back button was not rendered");
    const toolbar = back.closest(".h-10");

    expect(toolbar).not.toBeNull();
    expect(back.parentElement).toHaveClass("flex-1");
    expect(back.parentElement).not.toHaveClass("ml-auto");
    expect(within(toolbar as HTMLElement).queryByText("All")).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Assistant"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Tabular"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Add-ons"),
    ).not.toBeInTheDocument();

    await user.click(back);
    expect(setActiveTab).toHaveBeenCalledWith(
      "addons",
      "/workflows/addons",
    );
  });

  it("uses black pill buttons for row and bulk imports", async () => {
    const user = userEvent.setup();
    listWorkflowAddons.mockResolvedValue([
      {
        id: "addon-1",
        addon_key: "draft-from-precedent",
        pack_key: null,
        pack_title: null,
        pack_description: null,
        pack_version: null,
        version: "1.0.0",
        title: "Draft from precedent",
        description: "Draft using a precedent.",
        type: "assistant",
        prompt_md: "Draft from the precedent.",
        contributors: [],
        language: "English",
        practice: "General Transactions",
        jurisdictions: ["General"],
        active: true,
        updated_at: "2026-08-28T00:00:00.000Z",
        reference_files: [],
      },
    ]);

    render(<WorkflowList initialTab="addons" />);

    const rowImport = await screen.findByRole("button", { name: "Import" });
    expect(rowImport).toHaveClass("bg-gray-950/88");

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes.at(-1)!);

    const importButtons = screen.getAllByRole("button", { name: "Import" });
    expect(importButtons).toHaveLength(2);
    importButtons.forEach((button) =>
      expect(button).toHaveClass("bg-gray-950/88"),
    );
  });
});
