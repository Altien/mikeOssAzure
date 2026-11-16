import { describe, expect, it } from "vitest";
import { AzureConsoleLogger, MemorySink } from "../azureConsoleLogger";

// The finish reason is the field that explains a cut-off answer; it must reach the log line intact.
describe("debug records keep real finish reasons and model ids", () => {
  it.each(["tool-calls", "length", "stop", "content-filter"])("keeps %s", (finishReason) => {
    const sink = new MemorySink();
    const logger = new AzureConsoleLogger({
      sink,
      clock: { now: () => 0 },
      debugGate: { isOn: () => true },
      proc: "api",
      format: "json",
      bound: { tenantId: "contoso" },
    });
    const model = "tokenjuice/deepseek-ai/DeepSeek-V4.1-Flash-1017";
    logger.debug("llm.step.finish", { model, step: 2, inputTokens: 1, outputTokens: 2, finishReason, rawFinishReason: finishReason });
    const [record] = sink.records();
    expect(record?.data).toMatchObject({ model, finishReason, rawFinishReason: finishReason });
  });
});
