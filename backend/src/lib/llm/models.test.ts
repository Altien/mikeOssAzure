import { describe, expect, it } from "vitest";
import { isAllowedModelId, providerForModel } from "./models";

describe("Ollama (deferred upstream fe942475)", () => {
    it("does not accept or route local ollama/<tag> model ids", () => {
        expect(isAllowedModelId("ollama/llama3")).toBe(false);
        expect(() => providerForModel("ollama/llama3")).toThrow();
    });
});

describe("Kimi K3 model routing", () => {
    it("accepts kimi-k3 and routes it to the Kimi provider", () => {
        expect(isAllowedModelId("kimi-k3")).toBe(true);
        expect(providerForModel("kimi-k3")).toBe("kimi");
    });
});
