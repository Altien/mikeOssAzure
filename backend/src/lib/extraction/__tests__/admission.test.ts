import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtractionBusyError, withExtractionSlot } from "../isolated";
import { extractionTimeoutMs } from "../limits";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function occupy() {
  let release!: () => void;
  const held = withExtractionSlot({}, () => new Promise<void>((resolve) => { release = resolve; }));
  return { held, release };
}

describe("parser admission", () => {
  it("defers all excess durable jobs before their download callbacks run", async () => {
    const { held, release } = occupy();
    const downloadAndParse = vi.fn(async () => "text");
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => withExtractionSlot({ wait: false }, downloadAndParse)));
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ExtractionBusyError);
      }
      expect(downloadAndParse).not.toHaveBeenCalled();
    } finally { release(); await held; }
    await expect(withExtractionSlot({ wait: false }, downloadAndParse)).resolves.toBe("text");
  });

  it("expires interactive waiting after 30 seconds, without starting its download", async () => {
    vi.useFakeTimers();
    const { held, release } = occupy();
    const downloadAndParse = vi.fn(async () => "text");
    const waiting = withExtractionSlot({ interactive: true }, downloadAndParse);
    const rejected = expect(waiting).rejects.toBeInstanceOf(ExtractionBusyError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    release(); await held;
    expect(downloadAndParse).not.toHaveBeenCalled();
  });

  it("bounds queued requests and gives interactive requests priority", async () => {
    const { held, release } = occupy();
    const order: number[] = [];
    const waiting = Array.from({ length: 8 }, (_, index) => withExtractionSlot({ interactive: index === 7 }, async () => { order.push(index); }));
    try {
      await expect(withExtractionSlot({}, async () => {})).rejects.toBeInstanceOf(ExtractionBusyError);
    } finally { release(); await held; await Promise.all(waiting); }
    expect(order).toEqual([7, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("bounds retained queued buffers independently of request count", async () => {
    const { held, release } = occupy();
    const waiting = withExtractionSlot({ retainedBytes: 100 * 1024 * 1024 }, async () => {});
    try {
      await expect(withExtractionSlot({ retainedBytes: 51 * 1024 * 1024 }, async () => {})).rejects.toBeInstanceOf(ExtractionBusyError);
    } finally { release(); await held; await waiting; }
    await expect(withExtractionSlot({ retainedBytes: 150 * 1024 * 1024 }, async () => "free")).resolves.toBe("free");
  });

  it("releases a slot after a failure and clamps execution below the stale lease", async () => {
    await expect(withExtractionSlot({}, async () => { throw new Error("broken source"); })).rejects.toThrow("broken source");
    await expect(withExtractionSlot({ wait: false }, async () => "next")).resolves.toBe("next");
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "3600000");
    expect(extractionTimeoutMs()).toBe(300_000);
  });
});
