export type ToolLoopTurn = {
  iteration: number;
  toolsEnabled: boolean;
};

/**
 * maxIterations is the number of tool-enabled model turns. One final
 * tool-disabled turn is always available to synthesize the last tool result.
 */
export function toolLoopTurns(maxIterations: number): ToolLoopTurn[] {
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
    throw new Error("maxIterations must be a non-negative integer");
  }
  return Array.from({ length: maxIterations + 1 }, (_, iteration) => ({
    iteration,
    toolsEnabled: iteration < maxIterations,
  }));
}
