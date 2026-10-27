// One parser slot per calling thread. Queue coordination remains responsive;
// each parse runs in a disposable child process with its own failure boundary.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ExtractionOp, ExtractionOps } from "./ops";
import { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError, extractionMemoryMb, extractionTimeoutMs } from "./limits";

export { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError } from "./limits";

type Result<K extends ExtractionOp> = Awaited<ReturnType<ExtractionOps[K]>>;
export type ExtractInSlot = <K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options?: { fileType?: string }) => Promise<Result<K>>;
type Reply = { ok: true; result: unknown } | { ok: false; limited: boolean; message: string };

/** Hard OS memory boundary on Linux, including native buffers. Fail closed if
 * prlimit is unavailable. Other platforms retain process/heap and archive
 * bounds, but do not claim the Linux OS-memory guarantee.
 */
export function extractionCommand(entry: string): { command: string; args: string[] } {
  const memoryMb = extractionMemoryMb();
  const nodeArgs = [
    "--disable-wasm-trap-handler",
    `--max-old-space-size=${Math.max(1, Math.floor(memoryMb / 2))}`,
    ...(entry.endsWith(".ts") ? ["--require", require.resolve("tsx/cjs")] : []),
    entry,
  ];
  if (process.platform === "linux") {
    const bytes = memoryMb * 1024 * 1024;
    // Writable heap/native allocations share the data limit. V8 also reserves
    // address space for code (and the TS loader in dev); bound that separately.
    const addressBytes = bytes + 1024 ** 3;
    return { command: "prlimit", args: [`--data=${bytes}:${bytes}`, `--as=${addressBytes}:${addressBytes}`, "--core=0:0", "--", process.execPath, ...nodeArgs] };
  }
  return { command: process.execPath, args: nodeArgs };
}

function killParser(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => { child.kill("SIGKILL"); });
  } else {
    // Includes LibreOffice descendants, including after the parser has exited.
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

async function extractInChild<K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options: { fileType?: string } = {}): Promise<Result<K>> {
  if (bytes.byteLength > EXTRACTION_MAX_BYTES) throw new ExtractionLimitError("source exceeds 150 MB");
  if (process.env.EXTRACTION_ISOLATION === "off") {
    // Explicit escape hatch, also used by suites whose parser mocks live here.
    const { EXTRACTION_OPS } = await import("./ops.js");
    return await EXTRACTION_OPS[op](bytes, options.fileType ?? "") as Result<K>;
  }
  const entry = path.join(__dirname, __filename.endsWith(".ts") ? "process.ts" : "process.js");
  const { command, args } = extractionCommand(entry);
  const scratch = await mkdtemp(path.join(tmpdir(), "mike-extraction-"));
  return new Promise<Result<K>>((resolve, reject) => {
    // Do not inherit NODE_OPTIONS: it can override limits or preload app code.
    // Parser-only environment: no Supabase, object-store, or provider secrets.
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "SystemRoot", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "SOFFICE_BINARY_PATH", "LIBREOFFICE_BINARY_PATH", "LIBRE_OFFICE_EXE", "EXTRACTION_MAX_MEMORY_MB", "EXTRACTION_MAX_EXPANDED_MB"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    env.TMPDIR = env.TMP = env.TEMP = scratch;
    // glibc's per-thread malloc arenas can reserve enough address space to
    // exhaust RLIMIT_AS at low actual usage (especially with the TS loader).
    // Bound arena proliferation without relaxing either OS memory limit.
    env.MALLOC_ARENA_MAX = "2";
    const child = spawn(command, args, {
      env, detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
    });
    const onParentExit = () => killParser(child);
    process.once("exit", onParentExit);
    let reply: Reply | undefined;
    let failure: Error | undefined;
    let diagnostics = "";
    const timeout = setTimeout(() => {
      failure = new ExtractionLimitError("parser deadline exceeded");
      killParser(child);
    }, extractionTimeoutMs());
    child.stderr?.on("data", (chunk: Buffer) => {
      // Inspect bounded diagnostics only for OOM classification. Never log them.
      diagnostics = (diagnostics + chunk.toString()).slice(-8192);
    });
    child.once("message", (message: Reply) => {
      if (!failure) reply = message;
      killParser(child);
    });
    child.once("error", (error) => { failure = error; killParser(child); });
    child.once("close", (_code, signal) => {
      clearTimeout(timeout);
      process.removeListener("exit", onParentExit);
      killParser(child);
      void rm(scratch, { recursive: true, force: true }).then(() => {
        // A timed-out child must be gone before the next file gets this slot.
        if (failure instanceof ExtractionLimitError) reject(failure);
        else if (reply?.ok) resolve(reply.result as Result<K>);
        else if (reply) reject(reply.limited ? new ExtractionLimitError(reply.message) : new Error(reply.message));
        else if (signal === "SIGABRT" || /out of memory|allocation failed|cannot allocate memory|failed to map segment|ENOMEM/i.test(diagnostics)) {
          reject(new ExtractionLimitError("parser memory budget exceeded"));
        } else reject(failure ?? new Error("extraction process exited without a result"));
      }, reject);
    });
    child.once("spawn", () => child.send({ op, bytes, fileType: options.fileType ?? "" }, (error) => {
      if (error && !reply && !failure) { failure = error; killParser(child); }
    }));
  });
}

type Waiting = { interactive: boolean; bytes: number; grant: () => void; timer: ReturnType<typeof setTimeout> };
const queue: Waiting[] = [];
let occupied = false;
let queuedBytes = 0;
const MAX_WAITERS = 8;
const MAX_WAIT_MS = 30_000;

/** Reserve BEFORE downloading. Durable jobs use wait:false and defer back to
 * Postgres; they never spend their ten-minute claim lease in this local queue.
 * Interactive requests have bounded queue length, retained bytes, and wait.
 */
export async function withExtractionSlot<T>(
  options: { wait?: boolean; interactive?: boolean; retainedBytes?: number },
  work: (extract: ExtractInSlot) => Promise<T>,
): Promise<T> {
  if (occupied) {
    const bytes = options.retainedBytes ?? 0;
    if (options.wait === false || queue.length >= MAX_WAITERS || queuedBytes + bytes > EXTRACTION_MAX_BYTES) {
      throw new ExtractionBusyError();
    }
    await new Promise<void>((resolve, reject) => {
      const task: Waiting = {
        interactive: options.interactive === true, bytes, grant: resolve,
        timer: setTimeout(() => {
          const index = queue.indexOf(task);
          if (index < 0) return;
          queue.splice(index, 1);
          queuedBytes -= bytes;
          reject(new ExtractionBusyError());
        }, MAX_WAIT_MS),
      };
      queuedBytes += bytes;
      const before = task.interactive ? queue.findIndex((item) => !item.interactive) : -1;
      if (before < 0) queue.push(task); else queue.splice(before, 0, task);
    });
  } else occupied = true;
  try {
    return await work(extractInChild);
  } finally {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      queuedBytes -= next.bytes;
      next.grant();
    } else occupied = false;
  }
}

export function runIsolatedExtraction<K extends ExtractionOp>(
  op: K,
  bytes: ArrayBuffer | (() => Promise<ArrayBuffer | null>),
  options: { fileType?: string; interactive?: boolean } = {},
): Promise<Result<K>> {
  if (typeof bytes !== "function" && bytes.byteLength > EXTRACTION_MAX_BYTES) {
    return Promise.reject(new ExtractionLimitError("source exceeds 150 MB"));
  }
  return withExtractionSlot<Result<K>>({ interactive: options.interactive, retainedBytes: typeof bytes === "function" ? 0 : bytes.byteLength }, async (extract): Promise<Result<K>> => {
    const source = typeof bytes === "function" ? await bytes() : bytes;
    if (!source) throw new Error("document_text_source_unavailable");
    return extract(op, source, options);
  });
}
