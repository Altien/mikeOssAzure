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

/** Chars-per-token ratio used to estimate document size against a context window. */
export const PLAYBOOK_CHARS_PER_TOKEN =
  Number(process.env.PLAYBOOK_CHARS_PER_TOKEN) > 0
    ? Math.floor(Number(process.env.PLAYBOOK_CHARS_PER_TOKEN))
    : 4;

/** Multiplier applied to stored bytes for compressed office/PDF formats. */
export const PLAYBOOK_COMPRESSED_BYTES_MULTIPLIER =
  Number(process.env.PLAYBOOK_COMPRESSED_BYTES_MULTIPLIER) > 0
    ? Math.floor(Number(process.env.PLAYBOOK_COMPRESSED_BYTES_MULTIPLIER))
    : 4;

const COMPRESSED_FILE_TYPE_RE =
  /(?:^|\.)(?:docx?|pdf|odt|xlsx|pptx|zip)(?:$|\.)/i;

export function estimateDocumentChars(info: {
  inline_text?: string;
  size_bytes?: number | null;
  file_type?: string;
}): number {
  if (info.inline_text !== undefined) return info.inline_text.length;
  const bytes = info.size_bytes ?? 0;
  if (bytes <= 0) return 0;
  const fileType = info.file_type ?? "";
  return COMPRESSED_FILE_TYPE_RE.test(fileType)
    ? bytes * PLAYBOOK_COMPRESSED_BYTES_MULTIPLIER
    : bytes;
}

export function estimateTokenCount(chars: number): number {
  return Math.max(1, Math.ceil(chars / PLAYBOOK_CHARS_PER_TOKEN));
}

/** Chunk the playbook when the attached docs would approach the model window. */
export function shouldChunkForContext(opts: {
  contextWindowTokens: number;
  documentTokens: number;
  overheadTokens: number;
}): boolean {
  return (
    opts.documentTokens + opts.overheadTokens > opts.contextWindowTokens
  );
}

/**
 * Per-chunk source budget derived from the model's context window, leaving
 * room for history/instructions/tools/answer. Capped by PLAYBOOK_CHUNK_MAX_CHARS.
 */
export function chunkBudgetCharsForContext(opts: {
  contextWindowTokens: number;
  overheadTokens: number;
}): number {
  const availableTokens = Math.max(1, opts.contextWindowTokens - opts.overheadTokens);
  const budgetChars = Math.floor(availableTokens * PLAYBOOK_CHARS_PER_TOKEN);
  return Math.min(PLAYBOOK_CHUNK_MAX_CHARS, Math.max(1, budgetChars));
}

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
