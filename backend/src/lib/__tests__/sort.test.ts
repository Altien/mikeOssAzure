import { describe, expect, it } from "vitest";
import { parseTabularReviewSort } from "../sort";

describe("parseTabularReviewSort", () => {
    it("accepts a supported sort key and direction", () => {
        expect(parseTabularReviewSort({ key: "documents", direction: "asc" })).toEqual({
            key: "documents",
            direction: "asc",
        });
    });

    it("falls back to created desc for unsupported values", () => {
        expect(parseTabularReviewSort({ key: "unknown", direction: "sideways" })).toEqual({
            key: "created",
            direction: "desc",
        });
    });
});
