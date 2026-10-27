import { afterEach, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { validateExtractionInput, validateExtractionResult } from "../validate";
import { ExtractionLimitError } from "../limits";

afterEach(() => vi.unstubAllEnvs());

it("limits the sum of expanded entries rather than each entry independently", async () => {
  vi.stubEnv("EXTRACTION_MAX_EXPANDED_MB", "1");
  const zip = new JSZip();
  zip.file("a", Buffer.alloc(750_000));
  zip.file("b", Buffer.alloc(750_000));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await expect(validateExtractionInput(Uint8Array.from(bytes).buffer)).rejects.toBeInstanceOf(ExtractionLimitError);
});

it("does not trust a ZIP entry that falsely claims to expand to zero bytes", async () => {
  const zip = new JSZip();
  zip.file("payload", Buffer.alloc(1024 * 1024));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(central).toBeGreaterThan(0);
  bytes.writeUInt32LE(0, central + 24); // Central directory's uncompressed size.
  bytes.writeUInt32LE(0, 22); // Local header's uncompressed size.
  await expect(validateExtractionInput(Uint8Array.from(bytes).buffer)).rejects.toThrow();
});

it("bounds UTF-8 text sent back to the parent process", () => {
  expect(() => validateExtractionResult({ text: "€".repeat(6 * 1024 * 1024) })).toThrow(ExtractionLimitError);
  expect(() => validateExtractionResult({ text: "ordinary clause", textlessPageCount: 0 })).not.toThrow();
});
