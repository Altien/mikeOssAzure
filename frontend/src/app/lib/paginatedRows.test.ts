import { describe, expect, it } from "vitest";
import {
    appendUniqueRows,
    paginationError,
    splitOverfetchedPage,
} from "./paginatedRows";

describe("paginatedRows", () => {
    it("splits an over-fetched page and reports whether another page exists", () => {
        expect(splitOverfetchedPage([1, 2, 3], 2)).toEqual({
            rows: [1, 2],
            hasMore: true,
        });
        expect(splitOverfetchedPage([1, 2], 2)).toEqual({
            rows: [1, 2],
            hasMore: false,
        });
    });

    it("appends only rows whose IDs have not already been loaded", () => {
        expect(
            appendUniqueRows(
                [{ id: "one", value: 1 }],
                [
                    { id: "one", value: 2 },
                    { id: "two", value: 2 },
                ],
            ),
        ).toEqual([
            { id: "one", value: 1 },
            { id: "two", value: 2 },
        ]);
    });

    it("preserves Error instances and wraps non-errors with the fallback", () => {
        const original = new Error("network failed");
        expect(paginationError(original, "fallback")).toBe(original);
        expect(paginationError("failure", "fallback")).toEqual(
            new Error("fallback"),
        );
    });
});
