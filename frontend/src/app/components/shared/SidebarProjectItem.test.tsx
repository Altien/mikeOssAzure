import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectChats, listTabularReviews } from "@/app/lib/mikeApi";
import type {
  Chat,
  Project,
  TabularReview,
} from "@/app/components/shared/types";
import {
  PROJECT_RECENT_ITEM_PAGE_SIZE,
  SidebarProjectItem,
  mergeProjectRecentItems,
} from "./SidebarProjectItem";

vi.mock("next/image", () => ({
  default: ({ className }: { className?: string }) => (
    <span aria-hidden="true" className={className} />
  ),
}));

vi.mock("@/app/lib/mikeApi", () => ({
  listProjectChats: vi.fn(),
  listTabularReviews: vi.fn(),
}));

let projectSeq = 0;
function project(): Project {
  // A fresh id per test keeps the module-level cache from leaking between
  // tests.
  projectSeq += 1;
  return { id: `project-${projectSeq}`, name: "Atlas" } as Project;
}

function chat(id: string, title: string | null, updatedAt: string): Chat {
  return {
    id,
    title,
    project_id: "p",
    user_id: "u",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: updatedAt,
  };
}

function review(id: string, title: string, updatedAt: string): TabularReview {
  return {
    id,
    title,
    project_id: "p",
    user_id: "u",
    columns_config: null,
    workflow_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: updatedAt,
  };
}

function renderItem(
  current: Project,
  options: { pathname?: string; expanded?: boolean } = {},
) {
  const onExpandedChange = vi.fn();
  const onOpenProject = vi.fn();
  const view = render(
    <SidebarProjectItem
      project={current}
      pathname={options.pathname ?? "/assistant"}
      expanded={options.expanded ?? true}
      onExpandedChange={onExpandedChange}
      onOpenProject={onOpenProject}
    />,
  );
  return { ...view, onExpandedChange, onOpenProject };
}

describe("mergeProjectRecentItems", () => {
  it("interleaves chats and reviews newest first with project links", () => {
    const items = mergeProjectRecentItems(
      "p1",
      [
        chat("c1", "Old chat", "2026-10-01T00:00:00Z"),
        chat("c2", null, "2026-10-04T00:00:00Z"),
      ],
      [review("r1", "Lease review", "2026-10-03T00:00:00Z")],
    );

    expect(items.map((item) => [item.kind, item.title, item.href])).toEqual([
      ["chat", "Untitled chat", "/projects/p1/assistant/chat/c2"],
      ["review", "Lease review", "/projects/p1/tabular-reviews/r1"],
      ["chat", "Old chat", "/projects/p1/assistant/chat/c1"],
    ]);
  });
});

describe("SidebarProjectItem", () => {
  beforeEach(() => {
    vi.mocked(listProjectChats).mockReset();
    vi.mocked(listTabularReviews).mockReset();
    vi.mocked(listProjectChats).mockResolvedValue([
      chat("c1", "Due diligence", "2026-10-02T00:00:00Z"),
    ]);
    vi.mocked(listTabularReviews).mockResolvedValue([
      review("r1", "Lease review", "2026-10-05T00:00:00Z"),
    ]);
  });

  it("does not load anything while collapsed", () => {
    const { onExpandedChange } = renderItem(project(), { expanded: false });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show recent chats and reviews in Atlas",
      }),
    );

    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(listProjectChats).not.toHaveBeenCalled();
  });

  it("lists the project's chats and reviews newest first when expanded", async () => {
    const current = project();
    renderItem(current);

    const links = await screen.findAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Tabular review: Lease review",
      "Chat: Due diligence",
    ]);
    expect(links[0]).toHaveAttribute(
      "href",
      `/projects/${current.id}/tabular-reviews/r1`,
    );
    expect(listTabularReviews).toHaveBeenCalledWith(
      current.id,
      expect.objectContaining({
        offset: 0,
        limit: 11,
        sortKey: "created",
        sortDirection: "desc",
      }),
    );
  });

  it("marks the open chat as the current page", async () => {
    const current = project();
    renderItem(current, {
      pathname: `/projects/${current.id}/assistant/chat/c1`,
    });

    expect(
      await screen.findByRole("link", { name: "Chat: Due diligence" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows more rows with See more until everything is listed", async () => {
    const total = PROJECT_RECENT_ITEM_PAGE_SIZE + 2;
    vi.mocked(listProjectChats).mockResolvedValue(
      Array.from({ length: total }, (_, index) =>
        chat(`c${index}`, `Chat ${index}`, `2026-09-0${index + 1}T00:00:00Z`),
      ),
    );
    vi.mocked(listTabularReviews).mockResolvedValue([]);
    renderItem(project());

    const itemLinks = () =>
      screen.queryAllByRole("link", { name: /^(Chat|Tabular review):/ });
    await waitFor(() =>
      expect(itemLinks()).toHaveLength(PROJECT_RECENT_ITEM_PAGE_SIZE),
    );
    expect(
      screen.queryByRole("link", { name: "View all in project" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "See more" }));

    await waitFor(() => expect(itemLinks()).toHaveLength(total));
    expect(screen.queryByRole("button", { name: "See more" })).toBeNull();
  });

  it("fetches the next page of reviews when See more needs it", async () => {
    const current = project();
    vi.mocked(listProjectChats).mockResolvedValue([]);
    // Eleven rows tells the client there are more than one page of ten.
    vi.mocked(listTabularReviews)
      .mockResolvedValueOnce(
        Array.from({ length: 11 }, (_, index) =>
          review(`r${index}`, `Review ${index}`, `2026-09-${10 + index}T00:00:00Z`),
        ),
      )
      .mockResolvedValueOnce([
        review("r-old", "Oldest review", "2026-08-01T00:00:00Z"),
      ]);
    renderItem(current);

    await screen.findByRole("link", { name: "Tabular review: Review 9" });
    fireEvent.click(screen.getByRole("button", { name: "See more" }));
    fireEvent.click(await screen.findByRole("button", { name: "See more" }));

    expect(
      await screen.findByRole("link", { name: "Tabular review: Oldest review" }),
    ).toBeInTheDocument();
    expect(listTabularReviews).toHaveBeenLastCalledWith(
      current.id,
      expect.objectContaining({ offset: 10, limit: 11 }),
    );
  });

  it("shows an empty state", async () => {
    vi.mocked(listProjectChats).mockResolvedValue([]);
    vi.mocked(listTabularReviews).mockResolvedValue([]);
    renderItem(project());

    expect(
      await screen.findByText("No chats or reviews yet"),
    ).toBeInTheDocument();
  });

  it("still lists chats when only the reviews request fails", async () => {
    vi.mocked(listTabularReviews).mockRejectedValue(new Error("boom"));
    renderItem(project());

    expect(
      await screen.findByRole("link", { name: "Chat: Due diligence" }),
    ).toBeInTheDocument();
  });

  it("offers a retry when both requests fail", async () => {
    vi.mocked(listProjectChats).mockRejectedValueOnce(new Error("boom"));
    vi.mocked(listTabularReviews).mockRejectedValueOnce(new Error("boom"));
    renderItem(project());

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Chat: Due diligence" }),
      ).toBeInTheDocument(),
    );
  });
});
