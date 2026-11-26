import { afterEach, describe, expect, it, vi } from "vitest";
import { NullLogger } from "../azureConsoleLogger";
import { installStructuredLogging, logFormatFromEnv } from "../install";
import { log, resetRootLoggerForTests, setRootLogger } from "../root";
import { memoryLogger } from "./helpers";

afterEach(() => { resetRootLoggerForTests(); });

describe("root logger", () => {
  it("is a NullLogger until a composition root sets one", () => {
    expect(log()).toBeInstanceOf(NullLogger);
    expect(log().debugEnabled()).toBe(false);
    expect(log().with({ runId: "r" })).toBeInstanceOf(NullLogger);
  });

  it("resetRootLoggerForTests restores the NullLogger", () => {
    const { logger } = memoryLogger();
    setRootLogger(logger);
    expect(log()).toBe(logger);
    resetRootLoggerForTests();
    expect(log()).toBeInstanceOf(NullLogger);
  });

  it("chooses the format from LOG_FORMAT, else JSON only in production", () => {
    expect(logFormatFromEnv({ NODE_ENV: "production" })).toBe("json");
    expect(logFormatFromEnv({ NODE_ENV: "development" })).toBe("text");
    expect(logFormatFromEnv({ NODE_ENV: "production", LOG_FORMAT: "text" })).toBe("text");
    expect(logFormatFromEnv({ LOG_FORMAT: "JSON" })).toBe("json");
  });

  it("installStructuredLogging bridges a console, writes through its original methods, and uninstalls", () => {
    const original = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const target = { ...original } as unknown as Console;
    const logging = installStructuredLogging({ proc: "worker", target, env: { LOG_FORMAT: "json" } });
    try {
      expect(log()).toBe(logging.logger);
      target.warn("[dbq] claim lost", { id: "j-1" });
      log().info("process.start", { role: "all" });
      expect(original.warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(original.warn.mock.calls[0][0] as string)).toMatchObject({
        level: "warn", proc: "worker", msg: "[dbq] claim lost", args: [{ id: "j-1" }], src: "console",
      });
      expect(JSON.parse(original.log.mock.calls[0][0] as string)).toMatchObject({ level: "info", msg: "process.start" });
    } finally {
      logging.uninstall();
    }
    expect(target.warn).toBe(original.warn);
    expect(log()).toBeInstanceOf(NullLogger);
  });
});
