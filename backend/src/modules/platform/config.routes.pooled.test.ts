import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ failed: false, externalId: true }));
vi.mock("../../lib/config", () => ({
  getKeyVaultConfig: async () => "",
  getConfig: async (name: string) => {
    if (mocks.failed && name === "tenancy-mode") throw new Error("Vault unavailable");
    return ({
      "tenancy-mode": "pooled", "altien-entra-tenant-id": "external",
      "altien-entra-authority": "https://external.ciamlogin.com/external",
      "altien-entra-issuer": "https://external.ciamlogin.com/external/v2.0/",
      "altien-entra-jwks-uri": "https://external.ciamlogin.com/keys",
      "altien-entra-client-id": mocks.externalId ? "external-browser" : "", "altien-entra-backend-client-id": "external-api",
      "entra-client-id": "microsoft-browser", "entra-backend-client-id": "microsoft-api",
      "altien-entra-client-secret": "must-stay-on-server", "pooled-onboarding-url": "https://onboarding.example.test/", "control-plane-url": "https://control.example.test/members",
    } as Record<string, string>)[name] || "";
  },
}));
import { configRouter } from "./config.routes";
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AUTH_PROVIDER: process.env.AUTH_PROVIDER, TENANCY_MODE: process.env.TENANCY_MODE };
  process.env.AUTH_PROVIDER = "entra"; process.env.TENANCY_MODE = "pooled"; mocks.failed = false; mocks.externalId = true;
});
afterEach(() => { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
it("serves pooled public config at runtime without credentials", async () => {
  const response = await request(express().use("/config", configRouter)).get("/config");
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ tenancyMode: "pooled", controlPlaneUrl: "https://control.example.test/members", onboardingUrl: "https://onboarding.example.test/", entra: {
    tenantId: "external", clientId: "external-browser", authority: "https://external.ciamlogin.com/external", apiScope: "api://external-api/access_as_user",
  } });
  expect(response.text).not.toContain("must-stay-on-server");
  expect(response.body.externalIdSignIn).toBe(true);
});
it("publishes Microsoft only, and no External ID value, when External ID is not configured", async () => {
  mocks.externalId = false;
  const response = await request(express().use("/config", configRouter)).get("/config");
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ externalIdSignIn: false, entra: {
    tenantId: "common", clientId: "microsoft-browser", authority: "https://login.microsoftonline.com/common", apiScope: "api://microsoft-api/access_as_user",
  } });
  expect(response.text).not.toMatch(/ciamlogin|external-/);
});
it("fails closed when pooled mode cannot be read", async () => {
  mocks.failed = true;
  const response = await request(express().use("/config", configRouter)).get("/config");
  expect(response.status).toBe(503); expect(response.body).not.toHaveProperty("tenancyMode");
});
