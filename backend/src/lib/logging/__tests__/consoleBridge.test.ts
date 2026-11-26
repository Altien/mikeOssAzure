import { describe, expect, it, vi } from "vitest";
import { runWithTenant } from "../../tenantContext";
import { installConsoleBridge } from "../consoleBridge";
import type { ILogger } from "../types";
import { gateOn, memoryLogger } from "./helpers";

function fakeConsole() {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) => vi.fn((...args: unknown[]) => { calls.push([name, args]); });
  const target = { log: record("log"), info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") };
  return { target: target as unknown as Console, originals: { ...target }, calls };
}

describe("console bridge", () => {
  it("maps each method to its level, first string to msg and the rest to args", () => {
    const { target, calls } = fakeConsole();
    const { sink, logger } = memoryLogger({ gate: gateOn });
    installConsoleBridge(target, logger);
    runWithTenant({ tenantId: "contoso" }, () => {
      target.log("[a] one", { jobId: "j" });
      target.info("[b] two");
      target.warn("[c] three", 3);
      target.error({ just: "object" });
      target.debug("[d] gated on");
    });
    target.debug("[e] no tenant: gated off");
    expect(calls).toEqual([]);
    expect(sink.records().map(({ level, msg, args, src }) => ({ level, msg, args, src }))).toEqual([
      { level: "info", msg: "[a] one", args: [{ jobId: "j" }], src: "console" },
      { level: "info", msg: "[b] two", args: undefined, src: "console" },
      { level: "warn", msg: "[c] three", args: [3], src: "console" },
      { level: "error", msg: "", args: [{ just: "object" }], src: "console" },
      { level: "debug", msg: "[d] gated on", args: undefined, src: "console" },
    ]);
  });

  it("moves the first Error argument to err", () => {
    const { target } = fakeConsole();
    const { sink, logger } = memoryLogger();
    installConsoleBridge(target, logger);
    target.error("[x] failed", new Error("boom"), { id: 1 });
    expect(sink.records()[0]).toMatchObject({ msg: "[x] failed", err: { name: "Error", message: "boom" }, args: [{ id: 1 }] });
  });

  it("falls back to the original method with the raw arguments (same Error object) when the logger throws", () => {
    const { target, originals } = fakeConsole();
    const throwing = { console: () => { throw new Error("logger down"); } } as unknown as ILogger;
    installConsoleBridge(target, throwing);
    const error = new Error("boom");
    target.error("[x] failed", error);
    expect(originals.error).toHaveBeenCalledTimes(1);
    expect(originals.error.mock.calls[0][0]).toBe("[x] failed");
    expect(originals.error.mock.calls[0][1]).toBe(error);
  });

  it("uninstall restores every original method", () => {
    const { target, originals } = fakeConsole();
    const { logger } = memoryLogger();
    const uninstall = installConsoleBridge(target, logger);
    expect(target.warn).not.toBe(originals.warn);
    uninstall();
    uninstall();
    for (const method of ["log", "info", "warn", "error", "debug"] as const) expect(target[method]).toBe(originals[method]);
  });

  it("a wrapper installed after the bridge (Sentry) still receives the raw arguments", () => {
    const { target } = fakeConsole();
    const { sink, logger } = memoryLogger();
    installConsoleBridge(target, logger);
    const seen: unknown[][] = [];
    const bridged = target.error;
    target.error = (...args: unknown[]) => { seen.push(args); bridged(...args); };
    const error = new Error("boom");
    target.error("[x]", error);
    expect(seen[0][1]).toBe(error);
    expect(sink.records()[0].err?.message).toBe("boom");
  });
});
