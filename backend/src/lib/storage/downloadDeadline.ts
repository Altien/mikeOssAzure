import type { Readable } from "node:stream";

/** Whole-object source I/O deadline; parser execution has its own clock/slot. */
export function storageDownloadSignal(caller?: AbortSignal): AbortSignal {
  const value = Number(process.env.STORAGE_DOWNLOAD_TIMEOUT_MS);
  const milliseconds = Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : 120_000;
  const deadline = AbortSignal.timeout(milliseconds);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Storage download aborted", "AbortError");
}

/**
 * Consume a provider/file stream while retaining a bounded await even if its
 * close callback stalls. Destroy still tears down sockets/handles; the read
 * promise always has a rejection observer after the caller's slot is released.
 */
export async function collectStorageDownload(body: Readable, signal: AbortSignal): Promise<ArrayBuffer> {
  const reading = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      size += bytes.length;
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  })();
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => {
      const reason = abortReason(signal);
      // Reject the awaiting source loader independently of delayed OS close.
      reject(reason);
      body.destroy(reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    // Close the response-to-listener race, including a pre-aborted caller.
    if (signal.aborted) stop();
  });
  try {
    return await Promise.race([reading, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
