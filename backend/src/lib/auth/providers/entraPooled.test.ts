import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";

const mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("../../config", () => ({ getConfig: mocks.config }));
import { validateEntraToken } from "./entra";

const keys = [0, 1].map(() => generateKeyPairSync("rsa", { modulusLength: 2048 }));
const directory = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const enterprise = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const consumers = "9188040d-6c67-4c5b-b112-36a304b66dad";
const externalIssuer = "https://example.ciamlogin.com/" + directory + "/v2.0/";
const externalKeys = "https://example.ciamlogin.com/" + directory + "/discovery/v2.0/keys";
const commonKeys = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
let originalMode: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let settings: Record<string, string>;
function token(kind: number, changes: Record<string, unknown> = {}) {
  const claims = { oid: "same-user", tid: kind ? enterprise : directory, iss: kind ? "https://login.microsoftonline.com/" + enterprise + "/v2.0" : externalIssuer,
    aud: kind ? "enterprise-api" : "external-api", exp: Math.floor(Date.now() / 1000) + 3600, ...changes };
  const body = Buffer.from(JSON.stringify({ alg: "RS256", kid: "shared-kid" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url");
  return body + "." + createSign("RSA-SHA256").update(body).end().sign(keys[kind].privateKey).toString("base64url");
}
beforeEach(() => {
  originalMode = process.env.TENANCY_MODE;
  process.env.TENANCY_MODE = "pooled";
  settings = {
    "tenancy-mode": "pooled", "altien-entra-tenant-id": directory,
    "altien-entra-authority": "https://example.ciamlogin.com/" + directory,
    "altien-entra-issuer": externalIssuer, "altien-entra-jwks-uri": externalKeys,
    "altien-entra-client-id": "external-browser", "altien-entra-backend-client-id": "external-api",
    "entra-backend-client-id": "enterprise-api",
  };
  mocks.config.mockImplementation(async (name: string) => settings[name] || "");
  fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ keys: [{
    ...keys[url === externalKeys ? 0 : 1].publicKey.export({ format: "jwk" }), kid: "shared-kid",
  }] }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  if (originalMode === undefined) delete process.env.TENANCY_MODE; else process.env.TENANCY_MODE = originalMode;
  vi.unstubAllGlobals();
});
describe("pooled Entra validation", () => {
  it("validates External ID against its own issuer, audience and JWKS", async () => {
    expect(await validateEntraToken(token(0))).toMatchObject({ ok: true, principal: {
      userId: "same-user", identityKind: "altien", directoryId: directory, tenantId: undefined,
    } });
  });
  it("validates Microsoft directories against the shared key set without crossing the External ID JWKS cache", async () => {
    expect(await validateEntraToken(token(0))).toMatchObject({ ok: true });
    expect(await validateEntraToken(token(1))).toMatchObject({ ok: true, principal: {
      identityKind: "enterprise", directoryId: enterprise, tenantId: undefined,
    } });
    expect(fetchMock.mock.calls.every(([url]) => url === externalKeys || url === commonKeys)).toBe(true);
  });
  it("rejects forged issuer/tid pairs before key lookup", async () => {
    expect(await validateEntraToken(token(1, { iss: externalIssuer }))).toMatchObject({ ok: false, status: 401, detail: "Invalid issuer" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never accepts the workforce issuer for the External ID directory", async () => {
    expect(await validateEntraToken(token(0, { iss: "https://login.microsoftonline.com/" + directory + "/v2.0" }))).toMatchObject({ ok: false, detail: "Invalid issuer" });
  });
  it("validates any Microsoft directory, including personal accounts; admission is decided afterwards", async () => {
    expect(await validateEntraToken(token(1, { tid: consumers, iss: "https://login.microsoftonline.com/" + consumers + "/v2.0" })))
      .toMatchObject({ ok: true, principal: { identityKind: "enterprise", directoryId: consumers, tenantId: undefined } });
  });
  it("treats every Microsoft token as Microsoft when External ID is not configured", async () => {
    settings["altien-entra-client-id"] = "";
    expect(await validateEntraToken(token(1))).toMatchObject({ ok: true, principal: { identityKind: "enterprise" } });
    expect(await validateEntraToken(token(0))).toMatchObject({ ok: false, detail: "Invalid issuer" });
  });
  it("does not accept the enterprise audience through External ID", async () => {
    expect(await validateEntraToken(token(0, { aud: "enterprise-api" }))).toMatchObject({ ok: false, detail: "Invalid audience" });
  });
  it("fails closed when tenancy configuration is unavailable", async () => {
    mocks.config.mockRejectedValue(new Error("vault unavailable"));
    expect(await validateEntraToken(token(1))).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
