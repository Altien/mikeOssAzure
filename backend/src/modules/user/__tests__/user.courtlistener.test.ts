import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgRole: vi.fn(),
  resolveProviderSecret: vi.fn(),
  courtlistenerBulkDataEnabled: vi.fn(),
  loadCourtListenerConnection: vi.fn(),
  saveCourtListenerConnection: vi.fn(),
}));
vi.mock("../../lib/access", () => ({ getOrgRole: mocks.getOrgRole }));
vi.mock("../../lib/envSecrets", () => ({ resolveProviderSecret: mocks.resolveProviderSecret }));
vi.mock("../../lib/courtlistener", () => ({ courtlistenerBulkDataEnabled: mocks.courtlistenerBulkDataEnabled }));
vi.mock("../user.apiKeyStore", () => ({
  loadCourtListenerConnection: mocks.loadCourtListenerConnection,
  saveCourtListenerConnection: mocks.saveCourtListenerConnection,
}));

import { courtListenerConnectorStatus, setCourtListenerEnabled, setCourtListenerToken } from "../user.courtlistener";

const db = {} as never;
const personal = { userId: "u1", orgId: null };
const inFirm = { userId: "u1", orgId: "org-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgRole.mockResolvedValue("member");
  mocks.resolveProviderSecret.mockResolvedValue("");
  mocks.courtlistenerBulkDataEnabled.mockReturnValue(false);
  mocks.loadCourtListenerConnection.mockResolvedValue({ enabled: true, token: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("CourtListener connector status", () => {
  it.each([personal, inFirm])("uses only central credentials for workspace %i", async (owner) => {
    mocks.resolveProviderSecret.mockResolvedValue("central-token");
    expect(await courtListenerConnectorStatus(db, owner)).toEqual({
      enabled: true, installed: true, ownToken: false, tokenSource: "org", bulkData: false,
    });
    expect(mocks.resolveProviderSecret).toHaveBeenCalledWith("courtlistener-api-token");
    expect(mocks.loadCourtListenerConnection).toHaveBeenCalledWith(owner, db);
    expect(mocks.saveCourtListenerConnection).not.toHaveBeenCalled();
  });

  it("is installed by the bulk index alone when no central token is configured", async () => {
    mocks.courtlistenerBulkDataEnabled.mockReturnValue(true);
    expect(await courtListenerConnectorStatus(db, personal)).toMatchObject({
      enabled: true, installed: true, ownToken: false, tokenSource: null, bulkData: true,
    });
  });

  it("is not installed when enabled but neither central token nor bulk data is available", async () => {
    expect(await courtListenerConnectorStatus(db, personal)).toMatchObject({
      enabled: true, installed: false, ownToken: false, tokenSource: null, bulkData: false,
    });
  });

  it("preserves per-workspace enabled preference when centrally provisioned token is absent", async () => {
    mocks.loadCourtListenerConnection.mockResolvedValue({ enabled: false, token: null });
    mocks.resolveProviderSecret.mockResolvedValue("central-token");
    expect(await courtListenerConnectorStatus(db, inFirm)).toMatchObject({
      enabled: false, installed: false, ownToken: false, tokenSource: "org",
    });
  });

  it("rejects an organization role lookup failure", async () => {
    mocks.getOrgRole.mockResolvedValue(null);
    await expect(courtListenerConnectorStatus(db, inFirm)).rejects.toMatchObject({ status: 404 });
    expect(mocks.loadCourtListenerConnection).not.toHaveBeenCalled();
    expect(mocks.resolveProviderSecret).not.toHaveBeenCalled();
  });
});

describe("CourtListener connector changes", () => {
  it("saves only the workspace enabled preference", async () => {
    await setCourtListenerEnabled(db, inFirm, false);
    expect(mocks.saveCourtListenerConnection).toHaveBeenCalledWith(inFirm, { enabled: false }, db);
  });

  it("refuses token writes with the managed credentials response and never saves", async () => {
    await expect(setCourtListenerToken(db, inFirm, " token ")).rejects.toMatchObject({
      status: 403, code: "managed_credentials",
    });
    await expect(setCourtListenerToken(db, inFirm, null)).rejects.toMatchObject({
      status: 403, code: "managed_credentials",
    });
    expect(mocks.saveCourtListenerConnection).not.toHaveBeenCalled();
  });
});
