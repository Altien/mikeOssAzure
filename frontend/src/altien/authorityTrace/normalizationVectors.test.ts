import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    findPlainPassageMatches,
    normalizeWithPositions,
} from "../../../../backend/src/altien/authorityTrace/core/normalization";

type SharedVector = {
    name: string;
    raw: string;
    normalized?: string;
    proposed?: string;
    match?: "exact" | "normalized" | "hyphenless";
    quote?: string;
};

const sharedVectors = (
    JSON.parse(
        readFileSync(
            resolve(
                process.cwd(),
                "../docs/tests/fixtures/authority-trace-normalization.json",
            ),
            "utf8",
        ),
    ) as { vectors: SharedVector[] }
).vectors;

describe("shared Authority Trace normalization vectors", () => {
    it.each(sharedVectors)("$name", (vector) => {
        if (vector.normalized !== undefined) {
            expect(normalizeWithPositions(vector.raw).text).toBe(
                vector.normalized,
            );
        }
        if (vector.proposed !== undefined) {
            const result = findPlainPassageMatches(
                vector.raw,
                vector.proposed,
            );
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.matches[0]).toMatchObject({
                match: vector.match,
                quote: vector.quote,
            });
            expect(
                vector.raw.slice(
                    result.matches[0].start,
                    result.matches[0].end,
                ),
            ).toBe(vector.quote);
        }
    });
});
