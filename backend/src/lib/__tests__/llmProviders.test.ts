import { describe, expect, it } from "vitest";
import { fallbackReasoningLevelFromProviderError } from "../llm/providers";

describe("fallbackReasoningLevelFromProviderError", () => {
  it("selects the nearest level advertised by a provider", () => {
    const error = new Error(
      "Unsupported value: 'low' is not supported with the model. Supported values are: 'none', 'medium', 'high', and 'xhigh'.",
    );

    expect(fallbackReasoningLevelFromProviderError(error, "low")).toBe(
      "medium",
    );
  });

  it("does not retry unrelated provider failures", () => {
    expect(
      fallbackReasoningLevelFromProviderError(
        new Error("The provider is unavailable"),
        "high",
      ),
    ).toBeUndefined();
  });
});
