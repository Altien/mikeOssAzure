import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWithTenant } from "../../tenantContext";
import { sanitizeDebugFields } from "../debugEvents";
import { TenantDebugSwitches } from "../tenantDebugSwitches";
import { FakeClock, gateOn, memoryLogger } from "./helpers";

const step = { model: "claude-sonnet-4-5", step: 2, inputTokens: 18233, outputTokens: 912, finishReason: "tool-calls", rawFinishReason: null };

describe("debug events", () => {
  it("are dropped when the gate is off, and without a tenant even when it is on", () => {
    const off = memoryLogger();
    runWithTenant({ tenantId: "contoso" }, () => off.logger.debug("llm.step.finish", step));
    expect(off.sink.lines).toEqual([]);
    const on = memoryLogger({ gate: gateOn });
    on.logger.debug("llm.step.finish", step);
    expect(on.logger.debugEnabled()).toBe(false);
    expect(on.sink.lines).toEqual([]);
  });

  it("are emitted with event and data while the tenant's switch is on, and stop at expiry", async () => {
    const clock = new FakeClock();
    const switches = new TenantDebugSwitches({ clock });
    await switches.refresh(async () => [{ tenantId: "contoso", until: new Date(clock.now() + 1_000) }]);
    const { sink, logger } = memoryLogger({ gate: switches, clock });
    runWithTenant({ tenantId: "contoso", userId: "u-1" }, () => {
      logger.debug("llm.step.finish", step);
      clock.advance(1_000);
      logger.debug("llm.step.finish", step);
    });
    expect(sink.records()).toEqual([{
      ts: "2026-11-16T10:00:00.000Z", level: "debug", event: "llm.step.finish", proc: "api",
      tenantId: "contoso", userId: "u-1", data: { ...step },
    }]);
  });

  it("redact prose, over-long strings, arrays and objects at runtime", () => {
    expect(sanitizeDebugFields({
      model: "anthropic/claude-opus-4@2025+x=1",
      prose: "The tenant's contract says",
      file: "Lease agreement.docx",
      long: "a".repeat(129),
      list: ["a"],
      obj: { a: 1 },
      n: Number.NaN,
      ok: true,
      none: null,
      skip: undefined,
    })).toEqual({
      model: "anthropic/claude-opus-4@2025+x=1",
      prose: "[redacted]", file: "[redacted]", long: "[redacted]", list: "[redacted]", obj: "[redacted]",
      n: null, ok: true, none: null,
    });
  });

  it("allow-list field names never look like content", () => {
    const source = readFileSync(path.resolve(__dirname, "../debugEvents.ts"), "utf8");
    const block = /export interface DebugEventMap \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const names = [...block.matchAll(/([A-Za-z_]\w*)\??\s*:/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(80);
    const deny = /content|text|prompt|message|body|answer|query|arg|input$|output$|title|name$|file|snippet|email/i;
    const allowed = new Set(["toolName", "model", "inputTokens", "outputTokens", "errorCategory"]);
    expect(names.filter((name) => deny.test(name) && !allowed.has(name))).toEqual([]);
  });
});
