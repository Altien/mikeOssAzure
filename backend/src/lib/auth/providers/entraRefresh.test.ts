import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("./entra", () => ({ validateEntraToken: mocks.validate }));
vi.mock("../../config", () => ({ getConfig: async (name: string) => ({
  "tenancy-mode": "pooled", "altien-entra-tenant-id": "external-directory",
  "altien-entra-authority": "https://external.ciamlogin.com/external-directory",
  "altien-entra-issuer": "https://external.ciamlogin.com/external-directory/v2.0/",
  "altien-entra-jwks-uri": "https://external.ciamlogin.com/external-directory/discovery/v2.0/keys",
  "altien-entra-client-id": "external-browser", "altien-entra-backend-client-id": "external-api",
  "altien-entra-client-secret": "external-secret",
  "entra-client-id": "enterprise-browser", "entra-client-secret": "enterprise-secret",
  "entra-backend-client-id": "enterprise-api",
} as Record<string, string>)[name] || "" }));
import { renewEntraCredential } from "./entraRefresh";
const directoryId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
let savedMode: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  savedMode = process.env.TENANCY_MODE; process.env.TENANCY_MODE = "pooled";
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: "renewed", expires_in: 3600 }) }));
  vi.stubGlobal("fetch", fetchMock); mocks.validate.mockReset();
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.TENANCY_MODE; else process.env.TENANCY_MODE = savedMode;
  vi.unstubAllGlobals();
});
describe("pooled Entra refresh", () => {
  it("refreshes External ID sessions against the configured CIAM authority and client", async () => {
    const credential = { provider: "entra" as const, userId: "u", accessToken: "old", identityKind: "altien" as const, directoryId: "external-directory" };
    mocks.validate.mockResolvedValue({ ok: true, principal: credential });
    await renewEntraCredential("refresh", credential);
    expect(fetchMock.mock.calls[0][0]).toBe("https://external.ciamlogin.com/external-directory/oauth2/v2.0/token");
    const body = (fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body;
    expect(body.get("client_id")).toBe("external-browser"); expect(body.get("scope")).toContain("api://external-api/");
  });
  it("refreshes enterprise sessions against their verified directory and enterprise client", async () => {
    const credential = { provider: "entra" as const, userId: "u", accessToken: "old", identityKind: "enterprise" as const, directoryId };
    mocks.validate.mockResolvedValue({ ok: true, principal: credential });
    await renewEntraCredential("refresh", credential);
    expect(fetchMock.mock.calls[0][0]).toBe("https://login.microsoftonline.com/" + directoryId + "/oauth2/v2.0/token");
  });
  it("does not persist a refresh that changes directory or identity", async () => {
    mocks.validate.mockResolvedValue({ ok: true, principal: { userId: "u", identityKind: "altien", directoryId: "external-directory" } });
    await expect(renewEntraCredential("refresh", { provider: "entra", userId: "u", accessToken: "old", identityKind: "enterprise", directoryId })).rejects.toThrow("identity changed");
  });
});
