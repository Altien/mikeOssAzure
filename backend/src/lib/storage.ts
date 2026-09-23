import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { bestEffort } from "./observability/sentry";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { safeErrorLog } from "./safeError";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

// ─── Provider interface ────────────────────────────────────────────────────────
//
// Callers import the module-level functions below (uploadFile, downloadFile,
// deleteFile, getSignedUrl). Those signatures never change regardless of which
// provider is active. Adding a new provider means implementing this interface
// and updating createProvider() — nothing else.

export type StoredObjectMetadata = {
  size: number;
  etag: string | null;
  contentType: string | null;
};

export class StorageOperationError extends Error {
  constructor(readonly operation: string, options?: { cause?: unknown }) {
    super(`Object storage ${operation} failed`, options);
    this.name = "StorageOperationError";
  }
}

export interface StorageProvider {
  readonly kind: "r2" | "azure";
  upload(key: string, content: ArrayBuffer, contentType: string): Promise<void>;
  uploadFromPath(key: string, filePath: string, contentType: string): Promise<void>;
  download(key: string): Promise<ArrayBuffer | null>;
  readStream(key: string): Readable;
  head(key: string): Promise<StoredObjectMetadata | null>;
  copy(sourceKey: string, targetKey: string, sourceEtag?: string): Promise<void>;
  signedUpload(key: string, contentType: string, size: number, expiresIn: number): Promise<string | null>;
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
  readonly kind = "r2" as const;
  private readonly bucket: string;
  // Upstream caches the S3 client at module level (4f33843, "storage
  // caching"); dev's provider-class structure relocates that cache into the
  // provider instance. Upstream's requireStorageConfig() throw-on-upload is
  // already covered (more strongly) by requireProvider() below.
  private cachedClient?: S3Client;
  private cachedUploadSigningClient?: { endpoint: string; client: S3Client };

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
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
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

  async uploadFromPath(key: string, filePath: string, contentType: string): Promise<void> {
    const file = await stat(filePath);
    const body = createReadStream(filePath);
    try {
      await this.client().send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: body,
        ContentLength: file.size, ContentType: contentType,
      }));
    } catch (error) {
      throw new StorageOperationError("upload", { cause: error });
    } finally {
      body.destroy();
    }
  }

  readStream(key: string): Readable {
    const provider = this;
    return Readable.from((async function* () {
      try {
        const response = await provider.client().send(new GetObjectCommand({ Bucket: provider.bucket, Key: key }));
        if (!response.Body) throw new StorageOperationError("download");
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) yield chunk;
      } catch (error) {
        if (error instanceof StorageOperationError) throw error;
        throw new StorageOperationError("download", { cause: error });
      }
    })());
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const response = await this.client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: response.ContentLength ?? 0, etag: response.ETag ?? null, contentType: response.ContentType ?? null };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw new StorageOperationError("HEAD", { cause: error });
    }
  }

  async copy(sourceKey: string, targetKey: string, sourceEtag?: string): Promise<void> {
    try {
      await this.client().send(new CopyObjectCommand({
        Bucket: this.bucket, Key: targetKey,
        CopySource: encodeURIComponent(`${this.bucket}/${sourceKey}`).replace(/%2F/g, "/"),
        ...(sourceEtag ? { CopySourceIfMatch: sourceEtag } : {}),
      }));
      if (!await this.head(targetKey)) throw new StorageOperationError("copy");
    } catch (error) {
      if (error instanceof StorageOperationError) throw error;
      throw new StorageOperationError("copy", { cause: error });
    }
  }

  async signedUpload(key: string, contentType: string, size: number, expiresIn: number): Promise<string> {
    const endpoint = process.env.R2_PUBLIC_ENDPOINT_URL?.trim() || process.env.R2_ENDPOINT_URL!;
    if (this.cachedUploadSigningClient?.endpoint !== endpoint) {
      this.cachedUploadSigningClient = { endpoint, client: new S3Client({
        region: "auto", endpoint, forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
      }) };
    }
    try {
      return await awsGetSignedUrl(this.cachedUploadSigningClient.client,
        new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size }),
        { expiresIn, signableHeaders: new Set(["content-type", "content-length"]) });
    } catch (error) {
      throw new StorageOperationError("sign upload", { cause: error });
    }
  }

  async download(key: string): Promise<ArrayBuffer | null> {
    try {
      const response = await this.client().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return bytes.buffer as ArrayBuffer;
    } catch (error) {
      console.error("[storage] downloadFile failed", {
        key,
        error: safeErrorLog(error),
      });
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
    } catch (error) {
      console.error("[storage] getSignedUrl failed", {
        key,
        error: safeErrorLog(error),
      });
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
  readonly kind = "azure" as const;
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

  async uploadFromPath(key: string, filePath: string, contentType: string): Promise<void> {
    const body = createReadStream(filePath);
    try {
      await this.container.getBlockBlobClient(key).uploadStream(body, 8 * 1024 * 1024, 2, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    } catch (error) {
      throw new StorageOperationError("upload", { cause: error });
    } finally {
      body.destroy();
    }
  }

  readStream(key: string): Readable {
    const provider = this;
    return Readable.from((async function* () {
      try {
        const response = await provider.container.getBlobClient(key).download(0);
        if (!response.readableStreamBody) throw new StorageOperationError("download");
        for await (const chunk of response.readableStreamBody) yield chunk;
      } catch (error) {
        if (error instanceof StorageOperationError) throw error;
        throw new StorageOperationError("download", { cause: error });
      }
    })());
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const p = await this.container.getBlobClient(key).getProperties();
      return { size: p.contentLength ?? 0, etag: p.etag ?? null, contentType: p.contentType ?? null };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw new StorageOperationError("HEAD", { cause: error });
    }
  }

  async copy(sourceKey: string, targetKey: string, sourceEtag?: string): Promise<void> {
    const source = this.container.getBlobClient(sourceKey);
    try {
      const properties = await source.getProperties();
      if (sourceEtag && properties.etag !== sourceEtag) throw new StorageOperationError("source changed");
      const response = await source.download(0, undefined, { conditions: { ifMatch: sourceEtag ?? properties.etag } });
      if (!response.readableStreamBody) throw new StorageOperationError("download");
      await this.container.getBlockBlobClient(targetKey).uploadStream(response.readableStreamBody as Readable, 8 * 1024 * 1024, 2, {
        blobHTTPHeaders: { blobContentType: properties.contentType },
      });
      const target = await this.head(targetKey);
      if (!target || target.size !== properties.contentLength) throw new StorageOperationError("copy verification");
    } catch (error) {
      if (error instanceof StorageOperationError) throw error;
      throw new StorageOperationError("copy", { cause: error });
    }
  }

  async signedUpload(): Promise<null> {
    // Private Blob is reached through authenticated /api chunk upload, never
    // through a browser SAS that cannot traverse this account's firewall.
    return null;
  }

  async stagePart(key: string, blockId: string, stream: Readable, length: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.container.getBlockBlobClient(key).stageBlock(blockId, stream, length, { abortSignal: signal });
    } catch (error) {
      throw new StorageOperationError("stage part", { cause: error });
    }
  }

  async sealParts(key: string, blocks: string[], contentType: string): Promise<void> {
    try {
      await this.container.getBlockBlobClient(key).commitBlockList(blocks, {
        blobHTTPHeaders: { blobContentType: contentType }, conditions: { ifNoneMatch: "*" },
      });
    } catch (error) {
      throw new StorageOperationError("commit parts", { cause: error });
    }
  }

  async download(key: string): Promise<ArrayBuffer | null> {
    try {
      const buffer = await this.container.getBlobClient(key).downloadToBuffer();
      return buffer.buffer as ArrayBuffer;
    } catch (error) {
      console.error("[storage] downloadFile failed", {
        key,
        error: safeErrorLog(error),
      });
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

export function assertStorageConfigured(): void {
  requireProvider("clean up stored files");
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

export async function uploadFileFromPath(key: string, filePath: string, contentType: string): Promise<void> {
  await requireProvider("upload").uploadFromPath(key, filePath, contentType);
}

export function createFileReadStream(key: string): Readable {
  return requireProvider("download").readStream(key);
}

export async function headFile(key: string): Promise<StoredObjectMetadata | null> {
  return requireProvider("HEAD").head(key);
}

export async function copyFile(sourceKey: string, targetKey: string, sourceEtag?: string): Promise<void> {
  await requireProvider("copy").copy(sourceKey, targetKey, sourceEtag);
}

export function uploadTransport(): "direct" | "authenticated_parts" {
  return requireProvider("upload").kind === "azure" ? "authenticated_parts" : "direct";
}

export async function getSignedUploadUrl(
  key: string, contentType: string, size: number, expiresIn = 900,
): Promise<string | null> {
  return requireProvider("sign upload").signedUpload(key, contentType, size, expiresIn);
}

export async function stageUploadPart(key: string, blockId: string, stream: Readable, length: number, signal?: AbortSignal): Promise<void> {
  const provider = requireProvider("stage part");
  if (provider.kind !== "azure") throw new StorageOperationError("stage part transport");
  await (provider as AzureBlobProvider).stagePart(key, blockId, stream, length, signal);
}

export async function sealUploadParts(key: string, blocks: string[], contentType: string): Promise<void> {
  const provider = requireProvider("seal parts");
  if (provider.kind !== "azure") throw new StorageOperationError("seal parts transport");
  await (provider as AzureBlobProvider).sealParts(key, blocks, contentType);
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

/**
 * Delete an object the caller can live without but must not leak (a
 * rollback, a cancelled upload's staging blob). A failure here is not the
 * caller's failure, so instead of `.catch(() => {})` it is reported as a
 * warning grouped by `stage`. The key never goes on the event: keys embed
 * the user's original filename.
 */
export function deleteFileBestEffort(
  key: string,
  stage: string,
): Promise<void | undefined> {
  return bestEffort(deleteFile(key), {
    what: `storage-delete:${stage}`,
    tags: { component: "storage", stage, storage_operation: "delete" },
  });
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

export function externalSourceStorageKey(
  userId: string,
  docId: string,
  versionId: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionId}.txt`;
}

export function workflowReferenceKey(
  userId: string,
  workflowId: string,
  referenceId: string,
  contentHash: string,
  filename: string,
): string {
  return `workflow-references/${userId}/${workflowId}/${referenceId}/${contentHash}${storageExtension(filename, ".bin")}`;
}

/**
 * Cache slot for a document version's extracted plain text (see the
 * document.precompute_text job). Keyed by version id alone: versions are
 * immutable apart from two in-place rewrite sites, both of which invalidate
 * this key, so the version id fully identifies the bytes the text came from.
 */
export function extractedTextKey(versionId: string): string {
  return `extracted-text/${versionId}.txt`;
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
  // Non-ASCII goes in filename*; a raw non-latin1 char in the header throws ERR_INVALID_CHAR.
  return normalizeDownloadFilename(name)
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
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
