import { describe, expect, it, vi } from "vitest";
import {
  analyzePlaybookChunks,
  chunkBudgetCharsForContext,
  estimateDocumentChars,
  estimateTokenCount,
  shouldChunkForContext,
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

describe("context-window playbook chunking decision", () => {
  it("estimates tokens from stored bytes and inline text", () => {
    // 4 chars/token default: 10_000 chars => 2_500 tokens.
    expect(estimateTokenCount(10_000)).toBe(2_500);
    expect(estimateDocumentChars({ size_bytes: 4_000 })).toBe(4_000);
    expect(estimateDocumentChars({ inline_text: "abc" })).toBe(3);
    expect(estimateDocumentChars({})).toBe(0);
  });

  it("inflates compressed office/PDF byte sizes so they are not under-chunked", () => {
    expect(estimateDocumentChars({ size_bytes: 4_000, file_type: "docx" })).toBe(
      16_000,
    );
    expect(estimateDocumentChars({ size_bytes: 4_000, file_type: "pdf" })).toBe(
      16_000,
    );
  });

  it("chunks only when documents plus overhead approach the context window", () => {
    const contextWindowTokens = 208_000;
    // A 900K-char document ≈ 225K tokens past a 208K window.
    expect(
      shouldChunkForContext({
        contextWindowTokens,
        documentTokens: 225_000,
        overheadTokens: 8_000,
      }),
    ).toBe(true);
    // A 252K-char document ≈ 63K tokens fits comfortably.
    expect(
      shouldChunkForContext({
        contextWindowTokens,
        documentTokens: 63_000,
        overheadTokens: 8_000,
      }),
    ).toBe(false);
  });

  it("derives the per-chunk budget from the model context window", () => {
    const contextWindowTokens = 208_000;
    const overheadTokens = 8_000;
    const budgetChars = chunkBudgetCharsForContext({
      contextWindowTokens,
      overheadTokens,
    });
    expect(budgetChars).toBeGreaterThan(0);
    expect(budgetChars).toBeLessThanOrEqual(
      Number(process.env.PLAYBOOK_CHUNK_MAX_CHARS) || 75_000,
    );
    expect(budgetChars).toBeLessThanOrEqual(
      (contextWindowTokens - overheadTokens) * 4,
    );
  });
});
