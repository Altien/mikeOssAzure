import { describe, expect, it } from "vitest";
import { PRACTICE_AREA_OPTIONS } from "@/app/onboarding/options";
import { PRACTICE_OPTIONS } from "./practices";

describe("workflow practice options", () => {
    it("adds General Transactions to the personalization practice-area list", () => {
        expect(PRACTICE_OPTIONS).toEqual([
            "General Transactions",
            ...PRACTICE_AREA_OPTIONS,
        ]);
        expect(PRACTICE_AREA_OPTIONS).not.toContain("General Transactions");
    });
});
