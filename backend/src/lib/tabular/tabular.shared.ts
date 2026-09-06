/**
 * Types shared by the tabular extraction primitives and their callers.
 *
 * Split out of routes/tabular.ts so extraction can be reused outside the
 * tabular review routes. File layout mirrors upstream's lib/tabular/* so the
 * two trees converge rather than drift further apart.
 */

export type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
export type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

export type CellFlag = CellResult["flag"];

export const CELL_FLAGS: readonly CellFlag[] = [
  "green",
  "grey",
  "yellow",
  "red",
] as const;

export function normalizeCellFlag(value: unknown): CellFlag {
  return CELL_FLAGS.includes(value as CellFlag) ? (value as CellFlag) : "grey";
}
