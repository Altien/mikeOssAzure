import { describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_MODULE_KEYS,
  deploymentModuleEnabled,
  requireDeploymentModule,
  resolveDeploymentModules,
} from "../deploymentModules";

describe("deployment module registry", () => {
  it("preserves all packaged modules when configuration is omitted", () => {
    const modules = resolveDeploymentModules({});
    expect(Object.keys(modules)).toEqual([...DEPLOYMENT_MODULE_KEYS]);
    expect(Object.values(modules).every(Boolean)).toBe(true);
  });

  it("supports none and an explicit case-insensitive allow-list", () => {
    expect(Object.values(resolveDeploymentModules({ MIKE_ENABLED_MODULES: "none" })))
      .not.toContain(true);
    expect(
      resolveDeploymentModules({
        MIKE_ENABLED_MODULES: "legalMonitors, PLAYBOOKS, gmail",
      }),
    ).toMatchObject({
      legalMonitors: true,
      playbooks: true,
      gmail: true,
      promptLibrary: false,
      patentConnector: false,
    });
  });

  it("rejects unknown module names", () => {
    expect(() =>
      resolveDeploymentModules({ MIKE_ENABLED_MODULES: "playbooks,unknown" }),
    ).toThrow('Unsupported module "unknown"');
  });

  it("reports individual module availability", () => {
    expect(
      deploymentModuleEnabled("playbooks", {
        MIKE_ENABLED_MODULES: "playbooks",
      }),
    ).toBe(true);
    expect(
      deploymentModuleEnabled("legalMonitors", {
        MIKE_ENABLED_MODULES: "playbooks",
      }),
    ).toBe(false);
  });

  it("blocks unavailable module routes before their handler", () => {
    const original = process.env.MIKE_ENABLED_MODULES;
    process.env.MIKE_ENABLED_MODULES = "none";
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    try {
      requireDeploymentModule("playbooks")(
        {} as never,
        { status, json } as never,
        next,
      );
      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "module_unavailable",
          module: "playbooks",
        }),
      );
      expect(next).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.MIKE_ENABLED_MODULES;
      else process.env.MIKE_ENABLED_MODULES = original;
    }
  });
});
