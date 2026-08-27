import { describe, expect, it } from "vitest";
import {
    isOpenCodeGoModelId,
    openCodeGoApiModel,
    parseOpenCodeGoModelOptions,
} from "../llm/openCodeGoCatalog";

describe("OpenCode Go model ids", () => {
    it("round-trips namespaced catalog ids", () => {
        const id = "opencode-go/qwen3.8-max";
        expect(isOpenCodeGoModelId(id)).toBe(true);
        expect(openCodeGoApiModel(id)).toBe("qwen3.8-max");
    });

    it("rejects empty and unrelated ids", () => {
        expect(isOpenCodeGoModelId("opencode-go/ ")).toBe(false);
        expect(isOpenCodeGoModelId("opencode-go/qwen 3")).toBe(false);
        expect(isOpenCodeGoModelId(`opencode-go/${"x".repeat(257)}`)).toBe(
            false,
        );
        expect(openCodeGoApiModel("qwen3.8-max")).toBeNull();
    });
});

describe("parseOpenCodeGoModelOptions", () => {
    it("normalizes, deduplicates, and sorts valid catalog rows", () => {
        expect(
            parseOpenCodeGoModelOptions({
                data: [
                    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
                    { id: "glm-5", name: "GLM-5" },
                    { id: "qwen3.8-max", name: "Qwen3.8 Max updated" },
                    { id: "", name: "Invalid" },
                    null,
                ],
            }),
        ).toEqual([
            {
                id: "opencode-go/glm-5",
                label: "GLM-5",
                group: "OpenCode Go",
            },
            {
                id: "opencode-go/qwen3.8-max",
                label: "Qwen3.8 Max updated",
                group: "OpenCode Go",
            },
        ]);
    });

    it("falls back to the raw id when a row has no display name", () => {
        expect(
            parseOpenCodeGoModelOptions({
                data: [{ id: "kimi-k3", object: "model" }],
            }),
        ).toEqual([
            { id: "opencode-go/kimi-k3", label: "kimi-k3", group: "OpenCode Go" },
        ]);
    });

    it("returns an empty list for malformed responses", () => {
        expect(parseOpenCodeGoModelOptions(null)).toEqual([]);
        expect(parseOpenCodeGoModelOptions({ data: "invalid" })).toEqual([]);
    });
});
