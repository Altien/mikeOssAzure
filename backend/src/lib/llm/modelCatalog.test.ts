import { describe, expect, it } from "vitest";
import { MEMBER_KEY_PROVIDERS } from "./memberKeys";
import { memberKeyModelCatalog } from "./modelCatalog";
import { providerForModel } from "./models";

describe("memberKeyModelCatalog", () => {
  it("lists only member-key providers' models, each resolving to its stated provider", () => {
    const models = memberKeyModelCatalog();
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((model) => model.modelId)).size).toBe(models.length);
    for (const model of models) {
      expect(MEMBER_KEY_PROVIDERS).toContain(model.provider);
      expect(providerForModel(model.modelId)).toBe(model.provider);
    }
  });
});
