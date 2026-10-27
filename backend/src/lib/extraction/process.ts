// One file per process. No database, storage credentials, or application boot.
import { EXTRACTION_OPS, type ExtractionOp } from "./ops";
import { ExtractionLimitError, isAllocationFailure } from "./limits";
import { validateExtractionInput, validateExtractionResult } from "./validate";

process.once("message", (request: { op: ExtractionOp; bytes: ArrayBuffer; fileType: string }) => {
  void (async () => {
    try {
      await validateExtractionInput(request.bytes);
      const result = await EXTRACTION_OPS[request.op](request.bytes, request.fileType);
      validateExtractionResult(result);
      process.send?.({ ok: true, result });
    } catch (error) {
      const limited = error instanceof ExtractionLimitError || isAllocationFailure(error);
      process.send?.({
        ok: false, limited,
        message: limited ? "parser resource budget exceeded" : error instanceof Error ? error.message : "document extraction failed",
      });
    }
  })();
});

process.on("disconnect", () => {
  if (process.platform !== "win32") {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  } else process.exit(1);
});
