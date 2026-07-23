import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installProcessGuards } from "./processGuards";

// The end-to-end behaviour (a poison async handler not killing the
// server) is covered by the child-process test in downloadTokens.test.ts.
// These tests pin the handler wiring itself: what each guard does when it
// fires. We invoke the registered listeners directly rather than emitting
// real process events — emitting 'uncaughtException' on the vitest worker
// process would be indistinguishable from a genuine crash.

type Listener = (...args: unknown[]) => void;

let addedRejection: Listener[] = [];
let addedException: Listener[] = [];

function newListeners(event: string, before: Listener[]): Listener[] {
  return (process.listeners(event as "unhandledRejection") as Listener[]).filter(
    (l) => !before.includes(l),
  );
}

beforeEach(() => {
  const beforeRejection = process.listeners("unhandledRejection") as Listener[];
  const beforeException = process.listeners("uncaughtException") as Listener[];
  installProcessGuards();
  addedRejection = newListeners("unhandledRejection", beforeRejection);
  addedException = newListeners("uncaughtException", beforeException);
});

afterEach(() => {
  for (const l of addedRejection) process.removeListener("unhandledRejection", l);
  for (const l of addedException) process.removeListener("uncaughtException", l);
});

describe("installProcessGuards", () => {
  it("registers one listener for each guard event", () => {
    expect(addedRejection).toHaveLength(1);
    expect(addedException).toHaveLength(1);
  });

  it("unhandledRejection: logs and does NOT exit (the 041 crash-loop guard)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    addedRejection[0](new Error("escaped async handler"));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("unhandledRejection"),
      expect.any(Error),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("uncaughtException: logs and exits 1 (process state unknowable after a sync escape)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    addedException[0](new Error("sync escape"));

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
