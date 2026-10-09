import { describe, expect, it } from "vitest";
import { toolLoopTurns } from "./toolLoop";

describe("toolLoopTurns", () => {
  it("reserves one tool-disabled synthesis turn", () => {
    expect(toolLoopTurns(3)).toEqual([
      { iteration: 0, toolsEnabled: true },
      { iteration: 1, toolsEnabled: true },
      { iteration: 2, toolsEnabled: true },
      { iteration: 3, toolsEnabled: false },
    ]);
  });

  it("still permits a synthesis-only request when tools are disabled", () => {
    expect(toolLoopTurns(0)).toEqual([
      { iteration: 0, toolsEnabled: false },
    ]);
  });
});
