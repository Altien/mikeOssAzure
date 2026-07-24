import { describe, expect, it } from "vitest";
import { isAllowedModelId, providerForModel } from "./models";

describe("Kimi K3 model routing", () => {
    it("accepts kimi-k3 and routes it to the Kimi provider", () => {
        expect(isAllowedModelId("kimi-k3")).toBe(true);
        expect(providerForModel("kimi-k3")).toBe("kimi");
    });
});
