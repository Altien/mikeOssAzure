import { fromBufferPromise } from "yauzl";
import { EXTRACTION_MAX_BYTES, EXTRACTION_MAX_TEXT_BYTES, ExtractionLimitError, extractionExpandedBytes } from "./limits";

/** Stream every ZIP entry before a parser can inflate the archive wholesale.
 * Count actual output, not just the directory's size claims. Unlike JSZip's
 * file map, this visits duplicate entries and validates alleged empty entries.
 */
export async function validateExtractionInput(bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength > EXTRACTION_MAX_BYTES) throw new ExtractionLimitError("source exceeds 150 MB");
  const source = Buffer.from(bytes);
  if (source[0] !== 0x50 || source[1] !== 0x4b) return;
  const zip = await fromBufferPromise(source, { lazyEntries: true, validateEntrySizes: true });
  const limit = extractionExpandedBytes();
  let expanded = 0;
  let entries = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (++entries > 10_000) throw new ExtractionLimitError("too many archive entries");
      if (expanded + entry.uncompressedSize > limit) throw new ExtractionLimitError("expanded archive exceeds budget");
      // Even directory/empty entries are read: a forged name or size must not
      // hide bytes that a different ZIP parser might inflate later.
      const stream = await zip.openReadStreamPromise(entry);
      try {
        for await (const chunk of stream) {
          expanded += (chunk as Buffer).byteLength;
          if (expanded > limit) throw new ExtractionLimitError("expanded archive exceeds budget");
        }
      } finally { stream.destroy(); }
    }
  } finally { zip.close(); }
}

/** Huge text must stay in the child rather than exhausting the IPC recipient. */
export function validateExtractionResult(result: unknown): void {
  const text = typeof result === "string" ? result : (result as { text?: unknown } | null)?.text;
  if (typeof text === "string" && Buffer.byteLength(text) > EXTRACTION_MAX_TEXT_BYTES) {
    throw new ExtractionLimitError("extracted text exceeds 16 MB");
  }
}
