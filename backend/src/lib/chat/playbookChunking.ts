/**
 * Qwen's 131K context is shared by history, playbook instructions, tool
 * schemas, and the answer.  75K characters is a deliberately conservative
 * source budget (roughly 50K tokens at 1.5 characters/token), leaving room
 * for those other inputs and an 8K-token answer.
 */
export const PLAYBOOK_CHUNK_MAX_CHARS =
  Number(process.env.PLAYBOOK_CHUNK_MAX_CHARS) > 0
    ? Math.floor(Number(process.env.PLAYBOOK_CHUNK_MAX_CHARS))
    : 75_000;

export function splitPlaybookDocument(
  text: string,
  maxChars = PLAYBOOK_CHUNK_MAX_CHARS,
): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const limit = Math.min(text.length, offset + maxChars);
    if (limit === text.length) {
      chunks.push(text.slice(offset));
      break;
    }

    // Prefer a paragraph or line boundary, but never let a long paragraph
    // exceed the bounded request.
    const paragraph = text.lastIndexOf("\n\n", limit);
    const line = text.lastIndexOf("\n", limit);
    const boundary =
      paragraph > offset + maxChars * 0.5
        ? paragraph + 2
        : line > offset + maxChars * 0.5
          ? line + 1
          : limit;
    chunks.push(text.slice(offset, boundary));
    offset = boundary;
  }
  return chunks;
}

export async function analyzePlaybookChunks(args: {
  documents: { id: string; filename: string; text: string }[];
  maxChars?: number;
  signal?: AbortSignal;
  runPass: (chunk: {
    documentId: string;
    filename: string;
    index: number;
    total: number;
    text: string;
  }) => Promise<string>;
}): Promise<string[]> {
  const summaries: string[] = [];
  for (const document of args.documents) {
    const chunks = splitPlaybookDocument(document.text, args.maxChars);
    if (chunks.length <= 1) continue;
    for (const [index, text] of chunks.entries()) {
      if (args.signal?.aborted) {
        const error = new Error("Stream aborted.");
        error.name = "AbortError";
        throw error;
      }
      const summary = await args.runPass({
        documentId: document.id,
        filename: document.filename,
        index,
        total: chunks.length,
        text,
      });
      summaries.push(
        `Chunk ${index + 1} (${document.filename}):\n${summary.slice(0, 16_000)}`,
      );
    }
  }
  return summaries;
}
