import { describe, expect, it } from "vitest";
import { runWithRequestId } from "../../requestContext";
import { runWithTenant } from "../../tenantContext";
import { withLogContext } from "../contextLight";
import { MAX_LINE_BYTES } from "../serialize";
import { memoryLogger } from "./helpers";

describe("AzureConsoleLogger", () => {
  it("writes one JSON record with ts from the clock and omits unknown ids", () => {
    const { sink, logger } = memoryLogger();
    logger.info("process.start", { port: 3001 });
    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0])).toEqual({
      ts: "2026-11-16T10:00:00.000Z", level: "info", proc: "api", msg: "process.start", data: { port: 3001 },
    });
  });

  it("sends debug/info to the stdout level and warn/error to stderr levels", () => {
    const { sink, logger } = memoryLogger();
    logger.info("a");
    logger.warn("b");
    logger.error("c");
    expect(sink.levels).toEqual(["info", "warn", "error"]);
    expect(sink.records().map((r) => r.level)).toEqual(["info", "warn", "error"]);
  });

  it("reads tenant, user, request and overlay ids ambiently; with() wins", async () => {
    const { sink, logger } = memoryLogger();
    await runWithRequestId("req-1", () =>
      runWithTenant({ tenantId: "contoso", userId: "u-1", userEmail: "a@b.c", roles: ["Admin"] }, () =>
        withLogContext({ chatId: "chat-1", tenantId: "ignored" }, async () => {
          await Promise.resolve();
          logger.info("ambient");
          logger.with({ chatId: "chat-2", runId: "run-9" }).info("bound");
        })));
    const [ambient, bound] = sink.records();
    expect(ambient).toMatchObject({ tenantId: "contoso", userId: "u-1", requestId: "req-1", chatId: "chat-1" });
    expect(bound).toMatchObject({ tenantId: "contoso", chatId: "chat-2", runId: "run-9" });
    expect(sink.lines.join("\n")).not.toMatch(/a@b\.c|Admin|userEmail|roles/);
  });

  it("serialises errors with code, stack, one level of cause, and at most 5 aggregate errors", () => {
    const { sink, logger } = memoryLogger();
    const root = Object.assign(new Error("outer", { cause: new Error("inner", { cause: new Error("deepest") }) }), { code: "E_OUTER" });
    logger.error("failed", undefined, root);
    const aggregate = new AggregateError(Array.from({ length: 8 }, (_, i) => new Error(`e${i}`)), "many");
    logger.warn("agg", undefined, aggregate);
    const [one, two] = sink.records();
    expect(one.err).toMatchObject({ name: "Error", message: "outer", code: "E_OUTER", cause: { name: "Error", message: "inner" } });
    expect(one.err?.stack).toContain("outer");
    expect((one.err?.cause as { cause?: unknown }).cause).toBeUndefined();
    expect(two.err?.errors).toHaveLength(5);
  });

  it("redacts content-bearing keys case-insensitively and secrets in text", () => {
    const { sink, logger } = memoryLogger();
    logger.warn("Incorrect API key provided: sk-abcdefghijklmnopqrstu.", {
      Content: "the contract", nested: { prompt: "p", userEmail: "x@y.z", Authorization: "Bearer abc", keep: 1 },
      note: "token=abcdef123456",
    });
    const record = sink.records()[0];
    expect(record.msg).not.toContain("sk-abcdefghijklmnopqrstu");
    expect(record.data).toEqual({
      Content: "[redacted]",
      nested: { prompt: "[redacted]", userEmail: "[redacted]", Authorization: "[redacted]", keep: 1 },
      note: "token=[redacted]",
    });
  });

  it("caps each line at 16,000 bytes and marks it truncated", () => {
    const { sink, logger } = memoryLogger();
    const many = Array.from({ length: 20 }, () => "é".repeat(1_999));
    logger.error("big", { many }, new Error("x".repeat(5_000)));
    logger.console("warn", ["huge", ...many]);
    for (const line of sink.lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const [first, second] = sink.records();
    expect(first.truncated).toBe(true);
    expect(first.data).toBeUndefined();
    expect(first.err?.message.length).toBeLessThanOrEqual(2_100);
    expect(second).toMatchObject({ truncated: true, msg: "huge", src: "console" });
    expect(second.args).toBeUndefined();
  });

  it("never throws on circular, bigint, Buffer, throwing getters, functions and symbols", () => {
    const { sink, logger } = memoryLogger();
    const circular: Record<string, unknown> = { n: 1n };
    circular.self = circular;
    const hostile = { get boom() { throw new Error("getter"); } };
    expect(() => logger.info("odd", {
      circular, buf: Buffer.alloc(12), view: new Uint8Array(3), fn: () => 1, sym: Symbol("s"), hostile,
      deep: { a: { b: { c: { d: { e: 1 } } } } }, list: Array.from({ length: 25 }, (_, i) => i),
    })).not.toThrow();
    const data = sink.records()[0].data as Record<string, unknown>;
    expect(data.circular).toEqual({ n: "1", self: "[circular]" });
    expect(data.buf).toBe("[binary 12 bytes]");
    expect(data.view).toBe("[binary 3 bytes]");
    expect(data).not.toHaveProperty("fn");
    expect(data).not.toHaveProperty("sym");
    expect(data.hostile).toEqual({ boom: "[unreadable]" });
    expect(data.deep).toEqual({ a: { b: { c: "[object]" } } });
    expect((data.list as unknown[]).length).toBe(21);
  });

  it("swallows a failing sink for info/warn/error but lets console() throw for the bridge fallback", () => {
    const { logger } = memoryLogger();
    const broken = logger as unknown as { deps: { sink: { write: () => void } } };
    broken.deps.sink.write = () => { throw new Error("sink down"); };
    expect(() => logger.error("x")).not.toThrow();
    expect(() => logger.console("error", ["x"])).toThrow("sink down");
  });

  it("prints the text format with the same redaction", () => {
    const { sink, logger } = memoryLogger({ format: "text" });
    runWithTenant({ tenantId: "contoso", userId: "u-1" }, () => logger.warn("slow", { body: "secret", ms: 5 }));
    expect(sink.lines[0]).toBe('2026-11-16T10:00:00.000Z WARN [contoso/u-1] slow {"data":{"body":"[redacted]","ms":5}}');
  });
});
