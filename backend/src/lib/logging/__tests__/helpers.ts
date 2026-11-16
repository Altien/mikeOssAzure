import { AzureConsoleLogger, MemorySink } from "../azureConsoleLogger";
import type { DebugGate, LogFormat } from "../types";

export class FakeClock {
  constructor(public ms = Date.UTC(2026, 10, 16, 10, 0, 0)) {}
  now(): number { return this.ms; }
  advance(ms: number): void { this.ms += ms; }
}

export const gateOn: DebugGate = { isOn: (tenantId) => !!tenantId };
export const gateOff: DebugGate = { isOn: () => false };

export function memoryLogger(opts: { gate?: DebugGate; format?: LogFormat; clock?: FakeClock } = {}) {
  const sink = new MemorySink();
  const clock = opts.clock ?? new FakeClock();
  const logger = new AzureConsoleLogger({
    sink, clock, debugGate: opts.gate ?? gateOff, proc: "api", format: opts.format ?? "json",
  });
  return { sink, clock, logger };
}
