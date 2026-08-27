import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_FEATURES,
  getUserFeatures,
  normalizeUserFeatures,
  USER_FEATURE_KEYS,
} from "../userFeatures";

describe("user feature flags", () => {
  it("defaults every optional feature to enabled for existing users", () => {
    expect(normalizeUserFeatures(null)).toEqual(DEFAULT_USER_FEATURES);
    expect(Object.keys(DEFAULT_USER_FEATURES)).toEqual([...USER_FEATURE_KEYS]);
  });

  it("preserves explicit disabled flags and fills newly added flags", () => {
    expect(
      normalizeUserFeatures({
        promptLibrary: false,
        ironclad: false,
      }),
    ).toMatchObject({
      promptLibrary: false,
      ironclad: false,
      legalMonitors: true,
      playbooks: true,
    });
  });

  it("accepts SQLite JSON text", () => {
    expect(
      normalizeUserFeatures(
        JSON.stringify({ localModels: false, committeeModels: false }),
      ),
    ).toMatchObject({
      localModels: false,
      committeeModels: false,
      patentConnector: true,
    });
  });

  it("intersects stored user preferences with deployment availability", async () => {
    const original = process.env.MIKE_ENABLED_MODULES;
    process.env.MIKE_ENABLED_MODULES = "playbooks";
    const result = { data: { feature_flags: { playbooks: true, ironclad: true } }, error: null };
    const builder = {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => result,
    };
    try {
      const features = await getUserFeatures("user-1", {
        from: () => builder,
      } as never);
      expect(features.playbooks).toBe(true);
      expect(features.ironclad).toBe(false);
      expect(features.legalMonitors).toBe(false);
    } finally {
      if (original === undefined) delete process.env.MIKE_ENABLED_MODULES;
      else process.env.MIKE_ENABLED_MODULES = original;
    }
  });
});
