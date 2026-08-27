import { afterEach, describe, expect, it, vi } from "vitest";

const originalModelConfig = process.env.MIKE_MODEL_CONFIG_JSON;

afterEach(() => {
  if (originalModelConfig === undefined) {
    delete process.env.MIKE_MODEL_CONFIG_JSON;
  } else {
    process.env.MIKE_MODEL_CONFIG_JSON = originalModelConfig;
  }
  vi.resetModules();
});

describe("legal monitor model feature gating", () => {
  it("honors local and committee feature switches", async () => {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
      models: [
        {
          id: "local-review-model",
          label: "Local review model",
          provider: "openai-compatible",
          location: "local",
          apiModel: "review-model",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      ],
      committees: [
        {
          id: "review-committee",
          label: "Review committee",
          members: ["local-review-model"],
          chair: "gemini-3-flash-preview",
        },
      ],
    });
    vi.resetModules();

    const { legalMonitorModelEnabled } = await import("../legalMonitors");
    const features = {
      promptLibrary: true,
      legalMonitors: true,
      playbooks: true,
      ironclad: true,
      localModels: false,
      committeeModels: false,
      patentConnector: true,
    };

    expect(legalMonitorModelEnabled("local-review-model", features)).toBe(
      false,
    );
    expect(legalMonitorModelEnabled("review-committee", features)).toBe(false);
    expect(legalMonitorModelEnabled("gemini-3-flash-preview", features)).toBe(
      true,
    );
  });
});
