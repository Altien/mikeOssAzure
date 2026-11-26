// Multi-tenant issue 011: /download/:token enforces expiry and the token's
// tenant/user binding before any database or storage read.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  headFile: vi.fn(),
  openFileStream: vi.fn(),
  ensureDocAccess: vi.fn(),
  from: vi.fn(),
}));

// Upstream de138f6d: downloads answer from a HEAD and stream the object later.
vi.mock("../../../lib/storage", () => ({
  headFile: mocks.headFile,
  openFileStream: mocks.openFileStream,
  TenantStorageError: class TenantStorageError extends Error {},
}));
vi.mock("../../../lib/access", () => ({ ensureDocAccess: mocks.ensureDocAccess }));

let service: typeof import("../downloads.service");
let tokens: typeof import("../../../lib/downloadTokens");
let tenant: typeof import("../../../lib/tenantContext");

const INSTALL = "install-tenant";
const PATH = "documents/user-1/doc-1/source.pdf";

function query(row: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is"]) chain[method] = () => chain;
  chain.maybeSingle = async () => ({ data: row, error: null });
  chain.single = async () => ({ data: row, error: null });
  return chain;
}

const db = { from: mocks.from } as unknown as Db;

function download(token: string, ctx: { tenantId: string; userId: string }) {
  return tenant.runWithTenant(ctx, () =>
    service.resolveTokenDownload(db, { token, userId: ctx.userId, userEmail: undefined }));
}

beforeAll(async () => {
  process.env.DOWNLOAD_SIGNING_SECRET = "test-secret-32-bytes-long-enough!!";
  process.env.AUTH_PROVIDER = "local";
  process.env.DEFAULT_TENANT_ID = INSTALL;
  vi.resetModules();
  service = await import("../downloads.service.js");
  tokens = await import("../../../lib/downloadTokens.js");
  tenant = await import("../../../lib/tenantContext.js");
});

beforeEach(() => {
  mocks.from.mockReset();
  mocks.from.mockImplementation((table: string) =>
    table === "document_versions"
      ? query({ id: "v1", document_id: "doc-1" })
      : query({ id: "doc-1", user_id: "user-1", project_id: null, org_id: null, workflow_id: null }));
  mocks.ensureDocAccess.mockReset();
  mocks.ensureDocAccess.mockResolvedValue({ ok: true });
  mocks.headFile.mockReset();
  mocks.headFile.mockResolvedValue({ size: 3, etag: '"e"', contentType: null });
  mocks.openFileStream.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("resolveTokenDownload (bound tokens)", () => {
  it("serves a valid token to the caller it was minted for", async () => {
    const ctx = { tenantId: "tenant-a", userId: "user-1" };
    const token = tenant.runWithTenant(ctx, () => tokens.signDownload(PATH, "a.pdf"));
    const result = await download(token, ctx);
    expect(result).toMatchObject({ ok: true, download: { filename: "a.pdf", size: 3, etag: '"e"' } });
    expect(mocks.headFile).toHaveBeenCalledWith(PATH);
  });

  it("rejects an expired token before any read", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const ctx = { tenantId: "tenant-a", userId: "user-1" };
    const token = tenant.runWithTenant(ctx, () => tokens.signDownload(PATH, "a.pdf"));
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await download(token, ctx)).toEqual({ ok: false, kind: "invalid_link" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.headFile).not.toHaveBeenCalled();
  });

  it("rejects tenant B's token for a caller in tenant A before any read", async () => {
    const token = tenant.runWithTenant({ tenantId: "tenant-b", userId: "user-1" }, () =>
      tokens.signDownload(PATH, "a.pdf"));
    const result = await download(token, { tenantId: "tenant-a", userId: "user-1" });
    expect(result).toEqual({ ok: false, kind: "invalid_link" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.headFile).not.toHaveBeenCalled();
  });

  it("rejects another user's token in the same tenant", async () => {
    const token = tenant.runWithTenant({ tenantId: "tenant-a", userId: "user-2" }, () =>
      tokens.signDownload(PATH, "a.pdf"));
    const result = await download(token, { tenantId: "tenant-a", userId: "user-1" });
    expect(result).toEqual({ ok: false, kind: "invalid_link" });
  });

  it("still enforces document access for a valid token", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: false });
    const ctx = { tenantId: "tenant-a", userId: "user-1" };
    const token = tenant.runWithTenant(ctx, () => tokens.signDownload(PATH, "a.pdf"));
    expect(await download(token, ctx)).toEqual({ ok: false, kind: "not_found" });
    expect(mocks.headFile).not.toHaveBeenCalled();
  });

  it("accepts an old-format token for the install tenant only", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T00:00:00Z") });
    const { createHmac } = await import("node:crypto");
    const b64 = (b: string | Buffer) =>
      Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const enc = b64(JSON.stringify({ p: PATH, f: "a.pdf" }));
    const legacy = `${enc}.${b64(createHmac("sha256", process.env.DOWNLOAD_SIGNING_SECRET!).update(enc).digest())}`;
    expect(await download(legacy, { tenantId: "tenant-a", userId: "user-1" }))
      .toEqual({ ok: false, kind: "invalid_link" });
    expect(await download(legacy, { tenantId: INSTALL, userId: "user-1" }))
      .toMatchObject({ ok: true });
    // Pooled Entra stamps have no configured install tenant.
    mocks.from.mockClear();
    process.env.AUTH_PROVIDER = "entra";
    const oldTid = process.env.ENTRA_TENANT_ID;
    delete process.env.ENTRA_TENANT_ID;
    tenant.resetTenantConfigCache();
    try {
      expect(await tenant.installTenantId()).toBeUndefined();
      expect(await download(legacy, { tenantId: INSTALL, userId: "user-1" })).toEqual({ ok: false, kind: "invalid_link" });
      expect(mocks.from).not.toHaveBeenCalled();
    } finally {
      process.env.AUTH_PROVIDER = "local";
      if (oldTid === undefined) delete process.env.ENTRA_TENANT_ID; else process.env.ENTRA_TENANT_ID = oldTid;
      tenant.resetTenantConfigCache();
    }
  });
});

describe("resolveBlobDownload (filesystem presigned GET)", () => {
  it("reads a tenant-prefixed key as the tenant the signed key names", async () => {
    const key = `t/tenant-b/${PATH}`;
    let seenTenant: string | undefined;
    mocks.headFile.mockImplementation(async () => {
      seenTenant = tenant.currentTenant()?.tenantId;
      return { size: 3, etag: null, contentType: null };
    });
    const result = await service.resolveBlobDownload(tokens.signBlobToken(key, "b.pdf", 60));
    expect(result).toMatchObject({ ok: true });
    expect(mocks.headFile).toHaveBeenCalledWith(key);
    expect(seenTenant).toBe("tenant-b");
    // The deferred open runs as that tenant too.
    let openTenant: string | undefined;
    mocks.openFileStream.mockImplementation(async () => {
      openTenant = tenant.currentTenant()?.tenantId;
      return null;
    });
    if (!result.ok) throw new Error("expected ok");
    await result.data.open(new AbortController().signal);
    expect(mocks.openFileStream).toHaveBeenCalledWith(key, expect.anything());
    expect(openTenant).toBe("tenant-b");
  });

  it("reads an unprefixed key with no added tenant scope", async () => {
    let seenTenant: string | undefined = "unset";
    mocks.headFile.mockImplementation(async () => {
      seenTenant = tenant.currentTenant()?.tenantId;
      return { size: 3, etag: null, contentType: null };
    });
    await service.resolveBlobDownload(tokens.signBlobToken(PATH, "a.pdf", 60));
    expect(seenTenant).toBeUndefined();
  });
});
