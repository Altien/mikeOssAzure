// Multi-tenant issue 010: storage is routed by the tenant context.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  locations: new Map<string, { account: string | null; container: string | null; region: string | null }>(),
  locationError: undefined as Error | undefined,
  azureUrls: [] as string[],
  azureUploads: [] as Array<{ container: string; key: string }>,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mocks.send;
  }
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client,
    PutObjectCommand: Command,
    CopyObjectCommand: Command,
    DeleteObjectCommand: Command,
    HeadObjectCommand: Command,
    ListObjectsV2Command: Command,
    GetObjectCommand: Command,
  };
});

vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));

vi.mock("@azure/storage-blob", () => {
  class BlobServiceClient {
    constructor(url: string) {
      mocks.azureUrls.push(url);
    }
    static fromConnectionString(): never {
      throw new Error("connection string must not be used for a registered account");
    }
    getContainerClient(container: string) {
      return {
        getBlockBlobClient: (key: string) => ({
          uploadData: async () => void mocks.azureUploads.push({ container, key }),
        }),
      };
    }
  }
  return { BlobServiceClient, ContainerClient: class {} };
});

vi.mock("../tenantStorageLocation", () => ({
  tenantStorageLocation: async (tenantId: string) => {
    if (mocks.locationError) throw mocks.locationError;
    return mocks.locations.get(tenantId) ?? { account: null, container: null, region: null };
  },
}));

let storage: typeof import("../storage");
let tenant: typeof import("../tenantContext");

const INSTALL = "install-tenant";
const bytes = new TextEncoder().encode("x").buffer as ArrayBuffer;

function sent(): Array<Record<string, unknown>> {
  return mocks.send.mock.calls.map(([command]) => (command as { input: Record<string, unknown> }).input);
}

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://r2.example.test";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET_NAME = "install-bucket";
  process.env.AUTH_PROVIDER = "local";
  process.env.DEFAULT_TENANT_ID = INSTALL;
  vi.resetModules();
  storage = await import("../storage.js");
  tenant = await import("../tenantContext.js");
  // The facade starts disabled; boot resolves the configured adapter.
  await storage.initStorage();
});

beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({});
  mocks.locations.clear();
  mocks.locationError = undefined;
  mocks.azureUrls.length = 0;
  mocks.azureUploads.length = 0;
  storage.resetTenantStorageProviders();
});

describe("tenant storage routing", () => {
  it("keeps the install tenant on the configured location and legacy keys", async () => {
    await tenant.runWithTenant({ tenantId: INSTALL }, () =>
      storage.uploadFile("documents/u1/d1/source.pdf", bytes, "application/pdf"));
    await storage.uploadFile("documents/u1/d2/source.pdf", bytes, "application/pdf");
    expect(sent()).toEqual([
      expect.objectContaining({ Bucket: "install-bucket", Key: "documents/u1/d1/source.pdf" }),
      expect.objectContaining({ Bucket: "install-bucket", Key: "documents/u1/d2/source.pdf" }),
    ]);
  });

  it("writes two tenants to separate locations under their own prefixes", async () => {
    mocks.locations.set("tenant-a", { account: null, container: "tenant-a-files", region: null });
    mocks.locations.set("tenant-b", { account: null, container: "tenant-b-files", region: null });
    await tenant.runWithTenant({ tenantId: "tenant-a" }, () =>
      storage.uploadFile("documents/u1/d1/source.pdf", bytes, "application/pdf"));
    await tenant.runWithTenant({ tenantId: "tenant-b" }, () =>
      storage.uploadFile("documents/u1/d1/source.pdf", bytes, "application/pdf"));
    expect(sent()).toEqual([
      expect.objectContaining({ Bucket: "tenant-a-files", Key: "t/tenant-a/documents/u1/d1/source.pdf" }),
      expect.objectContaining({ Bucket: "tenant-b-files", Key: "t/tenant-b/documents/u1/d1/source.pdf" }),
    ]);
  });

  it("refuses another tenant's key before any storage call", async () => {
    await tenant.runWithTenant({ tenantId: "tenant-a" }, async () => {
      const key = "t/tenant-b/documents/u1/d1/source.pdf";
      await expect(storage.uploadFile(key, bytes, "application/pdf")).rejects.toThrow(/tenant check/);
      await expect(storage.deleteFile(key)).rejects.toThrow(/tenant check/);
      await expect(storage.headFile(key)).rejects.toThrow(/tenant check/);
      await expect(storage.copyFile("documents/u1/a.pdf", key)).rejects.toThrow(/tenant check/);
      expect(await storage.downloadFile(key)).toBeNull();
      expect(await storage.listFiles("t/tenant-b/")).toEqual([]);
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("accepts a key that names the current tenant as-is", async () => {
    await tenant.runWithTenant({ tenantId: "tenant-a" }, () =>
      storage.deleteFile("t/tenant-a/documents/u1/d1/source.pdf"));
    expect(sent()).toEqual([expect.objectContaining({ Key: "t/tenant-a/documents/u1/d1/source.pdf" })]);
  });

  it("reaches a registered account with the managed identity", async () => {
    mocks.locations.set("tenant-c", { account: "tenantcstore", container: "files", region: "uksouth" });
    await tenant.runWithTenant({ tenantId: "tenant-c" }, () =>
      storage.uploadFile("documents/u1/d1/source.pdf", bytes, "application/pdf"));
    expect(mocks.azureUrls).toEqual(["https://tenantcstore.blob.core.windows.net"]);
    expect(mocks.azureUploads).toEqual([{ container: "files", key: "t/tenant-c/documents/u1/d1/source.pdf" }]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("strips the tenant prefix from listings", async () => {
    mocks.send.mockResolvedValueOnce({
      Contents: [{ Key: "t/tenant-a/documents/u1/x.pdf" }, { Key: "t/tenant-a/documents/u1/y.pdf" }],
    });
    const keys = await tenant.runWithTenant({ tenantId: "tenant-a" }, () =>
      storage.listFiles("documents/u1/"));
    expect(sent()[0]).toEqual(expect.objectContaining({ Prefix: "t/tenant-a/documents/u1/" }));
    expect(keys).toEqual(["documents/u1/x.pdf", "documents/u1/y.pdf"]);
  });

  it("hides other tenants' objects from the install tenant's listings", async () => {
    mocks.send.mockResolvedValueOnce({
      Contents: [{ Key: "documents/u1/x.pdf" }, { Key: "t/tenant-a/documents/u1/y.pdf" }],
    });
    expect(await storage.listFiles("")).toEqual(["documents/u1/x.pdf"]);
  });

  it("fails closed when another tenant's location cannot be read", async () => {
    mocks.locationError = new Error("registry down");
    await tenant.runWithTenant({ tenantId: "tenant-a" }, async () => {
      await expect(storage.uploadFile("documents/u1/x.pdf", bytes, "application/pdf"))
        .rejects.toThrow(/location unavailable/);
      // Merge into main: a lookup failure is misconfiguration, not absence —
      // reads throw like main's transport errors instead of answering null/[].
      await expect(storage.downloadFile("documents/u1/x.pdf")).rejects.toThrow(/location unavailable/);
      await expect(storage.listFiles("documents/u1/")).rejects.toThrow(/location unavailable/);
      await expect(storage.getSignedUrl("documents/u1/x.pdf")).rejects.toThrow(/location unavailable/);
    });
    await storage.uploadFile("documents/u1/x.pdf", bytes, "application/pdf");
    expect(sent()).toEqual([expect.objectContaining({ Bucket: "install-bucket", Key: "documents/u1/x.pdf" })]);
  });

  // Durable cleanup (storageCleanup, deleteUserExportArtifacts) lists then
  // deletes; an empty answer outside a tenant would finalize without deleting.
  it("throws from reads with no tenant on a pooled stamp", async () => {
    const previous = process.env.TENANCY_MODE;
    process.env.TENANCY_MODE = "pooled";
    try {
      await expect(storage.listFiles("exports/u1/")).rejects.toThrow(/outside a tenant/);
      await expect(storage.downloadFile("exports/u1/x.json")).rejects.toThrow(/outside a tenant/);
    } finally {
      if (previous === undefined) delete process.env.TENANCY_MODE;
      else process.env.TENANCY_MODE = previous;
    }
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps shared catalog objects on the configured location", async () => {
    mocks.locations.set("tenant-a", { account: null, container: "tenant-a-files", region: null });
    await storage.uploadFile("mike-workflows/wf/hash/a.docx", bytes, "application/octet-stream");
    await tenant.runWithTenant({ tenantId: "tenant-a" }, async () => {
      await expect(storage.uploadFile("mike-workflows/wf/hash/a.docx", bytes, "x"))
        .rejects.toThrow(/shared object/);
      mocks.send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1]) } });
      expect(await storage.downloadFile("mike-workflows/wf/hash/a.docx")).not.toBeNull();
    });
    expect(sent().map((input) => [input.Bucket, input.Key])).toEqual([
      ["install-bucket", "mike-workflows/wf/hash/a.docx"],
      ["install-bucket", "mike-workflows/wf/hash/a.docx"],
    ]);
  });

  it("copies a shared object into a tenant's own location through the process", async () => {
    mocks.locations.set("tenant-a", { account: null, container: "tenant-a-files", region: null });
    mocks.send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      const { Bucket, Key } = command.input;
      if (!("Body" in command.input) && Bucket === "install-bucket" && !("Prefix" in command.input)) {
        return { ContentLength: 1, ETag: "e1", ContentType: "application/pdf",
          Body: { transformToByteArray: async () => new Uint8Array([1]) } };
      }
      if (Bucket === "tenant-a-files" && Key === "t/tenant-a/documents/u1/d1/source.pdf") {
        return { ContentLength: 1, ETag: "e2" };
      }
      return {};
    });
    await tenant.runWithTenant({ tenantId: "tenant-a" }, () =>
      storage.copyFile("mike-workflows/wf/hash/a.pdf", "documents/u1/d1/source.pdf", "e1"));
    expect(sent().some((input) => input.Bucket === "tenant-a-files" && "Body" in input)).toBe(true);
  });
});
