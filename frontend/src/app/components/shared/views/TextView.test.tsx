import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TextView } from "./TextView";

const state = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: () => ({ bytes: state.bytes, loading: false, error: null }),
}));

function setText(text: string) {
    state.bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
}

beforeEach(() => {
    state.bytes = null;
});

it("renders Markdown with its tables and links, but never an image or raw HTML", () => {
    setText([
        "# Re: Contract",
        "",
        "| Item | Fee |",
        "| --- | --- |",
        "| Review | 500 |",
        "",
        "See [the deal room](https://example.com/deal).",
        "",
        "![tracker](https://tracker.example/pixel.png)",
        "",
        "<script>alert(1)</script>",
    ].join("\n"));
    const { container } = render(<TextView documentId="doc-1" filename="Deal.eml.md" />);

    expect(screen.getByRole("heading", { name: "Re: Contract" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "the deal room" }).getAttribute("href"))
        .toBe("https://example.com/deal");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
});

it("shows other text formats as written", () => {
    setText("# not a heading\n{\"a\": 1}");
    const { container } = render(<TextView documentId="doc-1" filename="data.json" />);
    expect(container.querySelector("pre")?.textContent).toBe("# not a heading\n{\"a\": 1}");
    expect(container.querySelector("h1")).toBeNull();
});
