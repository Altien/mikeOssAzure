import { describe, expect, it, vi } from "vitest";
import {
  analyzePlaybookChunks,
  splitPlaybookDocument,
} from "./playbookChunking";

describe("playbook document chunking", () => {
  it("keeps every chunk bounded and preserves all source text", () => {
    const source = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(20)}`;
    const chunks = splitPlaybookDocument(source, 70);
    expect(chunks.every((chunk) => chunk.length <= 70)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });

  it("runs large documents in independent passes without accumulating raw chunks", async () => {
    const source = Array.from(
      { length: 5 },
      (_, i) => `section-${i}-${"x".repeat(30)}`,
    ).join("\n\n");
    const seen: string[] = [];
    const runPass = vi.fn(async (chunk: { text: string }) => {
      seen.push(chunk.text);
      return `summary-${seen.length}`;
    });

    const summaries = await analyzePlaybookChunks({
      documents: [{ id: "doc-1", filename: "large.pdf", text: source }],
      maxChars: 70,
      runPass,
    });

    expect(runPass.mock.calls.length).toBeGreaterThan(1);
    expect(seen.join("")).toBe(source);
    expect(summaries.join(" ")).not.toContain("section-0-");
  });

  it("does not chunk ordinary-sized documents", async () => {
    const runPass = vi.fn();
    await expect(
      analyzePlaybookChunks({
        documents: [{ id: "doc-1", filename: "short.pdf", text: "short" }],
        runPass,
      }),
    ).resolves.toEqual([]);
    expect(runPass).not.toHaveBeenCalled();
  });

  it("preserves cancellation between passes", async () => {
    const controller = new AbortController();
    const runPass = vi.fn(async () => {
      controller.abort();
      return "first";
    });
    await expect(
      analyzePlaybookChunks({
        documents: [
          { id: "doc-1", filename: "large.pdf", text: "a".repeat(200) },
        ],
        maxChars: 75,
        signal: controller.signal,
        runPass,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
