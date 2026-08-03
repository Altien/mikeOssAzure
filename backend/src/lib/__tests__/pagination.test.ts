import { describe, expect, it } from "vitest";
import { parsePaginationQuery } from "../pagination";

describe("parsePaginationQuery", () => {
    it("parses valid limit and offset values", () => {
        expect(parsePaginationQuery({ limit: "15", offset: "3" })).toEqual({
            limit: 15,
            offset: 3,
        });
    });

    it("clamps invalid values to sensible defaults", () => {
        expect(parsePaginationQuery({ limit: "500", offset: "-2" })).toEqual({
            limit: 100,
            offset: 0,
        });
    });

    it("uses defaults when values are missing", () => {
        expect(parsePaginationQuery({})).toEqual({ limit: 20, offset: 0 });
    });
});
