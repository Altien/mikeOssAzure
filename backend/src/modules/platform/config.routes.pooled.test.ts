import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ failed: false }));
vi.mock("../../lib/config", () => ({
  getKeyVaultConfig: async () => "",
  getConfig: async (name: string) => {
    if (mocks.failed && name === "tenancy-mode") throw new Error("Vault unavailable");
    return ({
      "tenancy-mode": "pooled", "altien-entra-tenant-id": "external",
      "altien-entra-authority": "https://external.ciamlogin.com/external",
      "altien-entra-issuer": "https://external.ciamlogin.com/external/v2.0/",
      "altien-entra-jwks-uri": "https://external.ciamlogin.com/keys",
      "altien-entra-client-id": "external-browser", "altien-entra-backend-client-id": "external-api",
      "altien-entra-client-secret": "must-stay-on-server", "pooled-onboarding-url": "https://onboarding.example.test/", "control-plane-url": "https://control.example.test/members",
    } as Record<string, string>)[name] || "";
  },
}));
import { configRouter } from "./config.routes";
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AUTH_PROVIDER: process.env.AUTH_PROVIDER, TENANCY_MODE: process.env.TENANCY_MODE };
  process.env.AUTH_PROVIDER = "entra"; process.env.TENANCY_MODE = "pooled"; mocks.failed = false;
});
afterEach(() => { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
it("serves pooled public config at runtime without credentials", async () => {
  const response = await request(express().use("/config", configRouter)).get("/config");
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ tenancyMode: "pooled", controlPlaneUrl: "https://control.example.test/members", onboardingUrl: "https://onboarding.example.test/", entra: {
    tenantId: "external", clientId: "external-browser", authority: "https://external.ciamlogin.com/external", apiScope: "api://external-api/access_as_user",
  } });
  expect(response.text).not.toContain("must-stay-on-server");
});
it("fails closed when pooled mode cannot be read", async () => {
  mocks.failed = true;
  const response = await request(express().use("/config", configRouter)).get("/config");
  expect(response.status).toBe(503); expect(response.body).not.toHaveProperty("tenancyMode");
});
