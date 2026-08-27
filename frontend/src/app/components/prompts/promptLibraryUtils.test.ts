import { describe, expect, it } from "vitest";
import type { PromptLibraryItem } from "@/app/lib/mikeApi";
import { filterPrompts, promptCategories, splitTags } from "./promptLibraryUtils";

const prompt = (overrides: Partial<PromptLibraryItem>): PromptLibraryItem => ({
    id: "prompt-1",
    userId: null,
    source: "built_in",
    name: "Review contract",
    prompt: "Review the attached agreement.",
    description: null,
    promptType: "Assist",
    categories: ["Analyze"],
    practiceAreas: ["Corporate"],
    sourceRequirements: ["Files"],
    originalCreator: null,
    originalCreatedAt: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
});

const prompts = [
    prompt({ id: "built-in", name: "Review contract" }),
    prompt({ id: "user", userId: "u1", source: "user", name: "Draft motion", prompt: "Prepare a motion.", categories: ["Draft"], practiceAreas: ["Litigation"] }),
];

describe("prompt library filtering", () => {
    it("derives category counts", () => {
        expect(promptCategories(prompts)).toEqual([
            { name: "Analyze", count: 1 },
            { name: "Draft", count: 1 },
        ]);
    });

    it("filters by category, source, and searchable metadata", () => {
        expect(filterPrompts(prompts, "", "Draft").map((item) => item.id)).toEqual(["user"]);
        expect(filterPrompts(prompts, "", null, "built_in").map((item) => item.id)).toEqual(["built-in"]);
        expect(filterPrompts(prompts, "litigation", null).map((item) => item.id)).toEqual(["user"]);
        expect(filterPrompts(prompts, "attached agreement", null).map((item) => item.id)).toEqual(["built-in"]);
    });

    it("normalizes comma-separated tags", () => {
        expect(splitTags("Analyze, Draft, Analyze,  ")).toEqual(["Analyze", "Draft"]);
    });
});
