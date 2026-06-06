import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

// ─── Provider interface ────────────────────────────────────────────────────────
//
// Callers import the module-level functions below (uploadFile, downloadFile,
// deleteFile, getSignedUrl). Those signatures never change regardless of which
// provider is active. Adding a new provider means implementing this interface
// and updating createProvider() — nothing else.

export interface StorageProvider {
  upload(key: string, content: ArrayBuffer, contentType: string): Promise<void>;
  download(key: string): Promise<ArrayBuffer | null>;
  /** All object keys under `prefix` (upstream 44e868e listFiles, relocated). */
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  /** Direct browser URL, or null when the provider delegates to the backend download proxy. */
  signedUrl(
    key: string,
    expiresIn: number,
    downloadFilename?: string,
  ): Promise<string | null>;
}

// ─── Cloudflare R2 provider ───────────────────────────────────────────────────

class R2Provider implements StorageProvider {
  private readonly bucket: string;
  // Upstream caches the S3 client at module level (4f33843, "storage
  // caching"); dev's provider-class structure relocates that cache into the
  // provider instance. Upstream's requireStorageConfig() throw-on-upload is
  // already covered (more strongly) by requireProvider() below.
  private cachedClient?: S3Client;

  constructor() {
    if (
      !process.env.R2_ENDPOINT_URL ||
      !process.env.R2_ACCESS_KEY_ID ||
      !process.env.R2_SECRET_ACCESS_KEY
    ) {
      throw new Error(
        "R2 storage requires R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY",
      );
    }
    this.bucket = process.env.R2_BUCKET_NAME ?? "mike";
  }

  private client(): S3Client {
    if (!this.cachedClient) {
      this.cachedClient = new S3Client({
        region: "auto",
        endpoint: process.env.R2_ENDPOINT_URL!,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      });
    }
    return this.cachedClient;
  }

  async upload(
    key: string,
    content: ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(content),
        ContentType: contentType,
      }),
    );
  }

  async download(key: string): Promise<ArrayBuffer | null> {
    try {
      const response = await this.client().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return bytes.buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let ContinuationToken: string | undefined;
    do {
      const response = await this.client().send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) keys.push(item.Key);
      }
      ContinuationToken = response.NextContinuationToken;
    } while (ContinuationToken);
    return keys;
  }

  async remove(key: string): Promise<void> {
    await this.client().send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async signedUrl(
    key: string,
    expiresIn: number,
    downloadFilename?: string,
  ): Promise<string | null> {
    try {
      const responseContentDisposition = downloadFilename
        ? buildContentDisposition("attachment", downloadFilename)
        : undefined;
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: responseContentDisposition,
      });
      return await awsGetSignedUrl(this.client(), command, { expiresIn });
    } catch {
      return null;
    }
  }
}

// ─── Azure Blob Storage provider ──────────────────────────────────────────────
//
// Auth priority:
//   1. AZURE_STORAGE_CONNECTION_STRING — connection string (local dev / Azurite)
//   2. AZURE_STORAGE_ACCOUNT_NAME      — account name + DefaultAzureCredential
//                                        (Managed Identity in Container Apps)
//
// Container name defaults to "documents"; override with AZURE_STORAGE_CONTAINER_NAME.
//
// signedUrl() returns null because Azure deployments use the backend download
// proxy (GET /download/:token) rather than direct storage URLs. The /url route
// falls back to buildDownloadUrl() when this returns null.

class AzureBlobProvider implements StorageProvider {
  private readonly container: ContainerClient;

  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const containerName =
      process.env.AZURE_STORAGE_CONTAINER_NAME ?? "documents";

    let serviceClient: BlobServiceClient;
    if (connectionString) {
      serviceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else if (accountName) {
      serviceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        new DefaultAzureCredential(),
      );
    } else {
      throw new Error(
        "Azure Blob Storage requires AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME",
      );
    }

    this.container = serviceClient.getContainerClient(containerName);
  }

  async upload(
    key: string,
    content: ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    const blob = this.container.getBlockBlobClient(key);
    await blob.uploadData(Buffer.from(content), {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async download(key: string): Promise<ArrayBuffer | null> {
    try {
      const buffer = await this.container.getBlobClient(key).downloadToBuffer();
      return buffer.buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      keys.push(blob.name);
    }
    return keys;
  }

  async remove(key: string): Promise<void> {
    await this.container.getBlobClient(key).deleteIfExists();
  }

  async signedUrl(
    _key: string,
    _expiresIn: number,
    _downloadFilename?: string,
  ): Promise<string | null> {
    return null;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createProvider(): StorageProvider {
  if (
    process.env.AZURE_STORAGE_ACCOUNT_NAME ||
    process.env.AZURE_STORAGE_CONNECTION_STRING
  ) {
    return new AzureBlobProvider();
  }
  if (
    process.env.R2_ENDPOINT_URL &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  ) {
    return new R2Provider();
  }
  throw new Error(
    "No storage provider configured. Set AZURE_STORAGE_ACCOUNT_NAME (Azure) " +
      "or R2_ENDPOINT_URL + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (Cloudflare R2).",
  );
}

let _provider: StorageProvider | null = null;
let _initError: Error | null = null;
try {
  _provider = createProvider();
} catch (err) {
  // Don't crash at startup — auth-only routes (e.g. /health, /auth/*) must
  // still work when storage is misconfigured. Defer the failure to the first
  // storage operation so the route returns a clear 500 instead of silently
  // dropping bytes (the previous behaviour did the latter — uploads "succeeded"
  // but no blob was written, leaving DB rows orphaned with paths that point
  // nowhere).
  _initError = err instanceof Error ? err : new Error(String(err));
}

export const storageEnabled = _provider !== null;

function requireProvider(op: string): StorageProvider {
  if (_provider) return _provider;
  const reason = _initError?.message ?? "no provider configured";
  throw new Error(`Storage is not configured (cannot ${op}): ${reason}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────
//
// These signatures are the stable contract. Callers never import the provider
// classes directly. Mutating operations (upload, remove) throw when storage is
// unconfigured so the failure surfaces immediately. Read operations
// (download, signedUrl) return null so callers can fall through to "not
// found" semantics without a 500.

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await requireProvider("upload").upload(key, content, contentType);
}

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  return _provider?.download(key) ?? null;
}

// Read operation — returns [] when storage is unconfigured, mirroring
// upstream 44e868e's `if (!storageEnabled) return []`.
export async function listFiles(prefix: string): Promise<string[]> {
  return _provider?.list(prefix) ?? [];
}

export async function deleteFile(key: string): Promise<void> {
  await requireProvider("delete").remove(key);
}

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  return _provider?.signedUrl(key, expiresIn, downloadFilename) ?? null;
}

// ─── Storage key helpers ──────────────────────────────────────────────────────

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}

// ─── Content-Disposition helpers ─────────────────────────────────────────────

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}
