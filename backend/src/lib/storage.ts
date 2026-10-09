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
import fs, { stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { signBlobToken, signBlobUploadToken } from "./downloadTokens";
import { Readable, Transform } from "node:stream";
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
  readonly kind: "r2" | "azure" | "fs";
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
  private cachedBrowserSigningClient?: { endpoint: string; client: S3Client };

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

  // Signs URLs the browser follows, so it uses the browser-reachable
  // endpoint (R2_PUBLIC_ENDPOINT_URL, falling back to R2_ENDPOINT_URL).
  private browserSigningClient(): S3Client {
    const endpoint = process.env.R2_PUBLIC_ENDPOINT_URL?.trim() || process.env.R2_ENDPOINT_URL!;
    if (this.cachedBrowserSigningClient?.endpoint !== endpoint) {
      this.cachedBrowserSigningClient = { endpoint, client: new S3Client({
        region: "auto", endpoint, forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
      }) };
    }
    return this.cachedBrowserSigningClient.client;
  }

  async signedUpload(key: string, contentType: string, size: number, expiresIn: number): Promise<string> {
    try {
      return await awsGetSignedUrl(this.browserSigningClient(),
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
      // The browser follows this URL, so sign it for the public endpoint.
      // (Dev: R2 only. AzureBlobProvider.signedUrl stays null: private Blob
      // bytes go through the authenticated /api download routes.)
      return await awsGetSignedUrl(this.browserSigningClient(), command, { expiresIn });
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

const FS_ROOT = process.env.STORAGE_FS_ROOT;

function backendPublicUrl(): string {
  return (
    process.env.BACKEND_PUBLIC_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`
  ).replace(/\/+$/, "");
}

// The one place a storage key becomes a filesystem path. Every fs call in this
// module goes through here, so containment is proven once rather than trusted
// three times.
//
// Keys are backend-constructed today, but they are built from user-supplied
// filenames, so resolve-and-check anyway: path.join alone is not a fence —
// it *canonicalizes* "../" rather than rejecting it, so join(root, "../x")
// happily lands outside root, and an absolute key ignores root entirely.
// path.resolve collapses both cases into one absolute path we can then test.
//
// The test is deliberately a SINGLE startsWith guard. An earlier shape —
//   if (resolved !== root && !resolved.startsWith(root + path.sep)) throw
// — is equally safe at runtime, but falling through it only proves a
// *disjunction* ("resolved is exactly root" OR "resolved is under root"),
// which neither a reader nor a static analyser can reduce to a containment
// fact; CodeQL reported the fs calls below as js/path-injection for precisely
// that reason. Falling through the form below proves one thing and nothing
// weaker: resolved is under rootPrefix.
//
// Comparing against root + path.sep, not bare root, is what closes the classic
// sibling escape — "/data/store-evil" startsWith "/data/store". The endsWith
// guard keeps that correct when root is itself a separator (e.g. "/").
function fsPathFor(key: string): string {
  const root = path.resolve(FS_ROOT!);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error(`storage key escapes STORAGE_FS_ROOT: ${key}`);
  }
  return resolved;
}

async function fsWalk(dir: string, out: string[], root: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await fsWalk(full, out, root);
    else if (entry.isFile())
      out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

// Upstream 89dc8323 filesystem driver, kept behind Dev's provider boundary.
// Integration dependency: upstream 80136892 later introduces StorageAdapter.
class FilesystemProvider implements StorageProvider {
  readonly kind = "fs" as const;
  constructor() {
    if (!FS_ROOT) throw new Error("STORAGE_FS_ROOT must be set when STORAGE_DRIVER=fs");
  }
  async upload(key: string, content: ArrayBuffer, _contentType: string): Promise<void> {
    const bytes = Buffer.from(content);
    await writeBlobFromStream(key, Readable.from([bytes]), bytes.length);
  }
  async uploadFromPath(key: string, source: string, _contentType: string): Promise<void> {
    const target = fsPathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.part`;
    try { await fs.copyFile(source, temp); await fs.rename(temp, target); }
    catch (error) { throw new StorageOperationError("upload", { cause: error }); }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  async download(key: string): Promise<ArrayBuffer | null> {
    try {
      const bytes = await fs.readFile(fsPathFor(key));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[storage] downloadFile failed", safeErrorLog(error));
      }
      return null;
    }
  }
  readStream(key: string): Readable {
    return Readable.from((async function* () {
      try { yield* createReadStream(fsPathFor(key)); }
      catch (error) { throw new StorageOperationError("download", { cause: error }); }
    })());
  }
  async head(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const info = await stat(fsPathFor(key));
      return { size: info.size, etag: null, contentType: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StorageOperationError("HEAD", { cause: error });
    }
  }
  async copy(sourceKey: string, targetKey: string, sourceEtag?: string): Promise<void> {
    if (sourceEtag) throw new StorageOperationError("source changed");
    await this.uploadFromPath(targetKey, fsPathFor(sourceKey), "application/octet-stream");
  }
  async list(prefix: string): Promise<string[]> {
    const root = path.resolve(FS_ROOT!);
    const lastSlash = prefix.lastIndexOf("/");
    const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash) : "";
    const all: string[] = [];
    await fsWalk(dirPart ? fsPathFor(dirPart) : root, all, root);
    return all.filter((key) => key.startsWith(prefix)).sort();
  }
  async remove(key: string): Promise<void> {
    try { await fs.unlink(fsPathFor(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async signedUpload(key: string, contentType: string, size: number, expiresIn: number): Promise<string> {
    fsPathFor(key);
    return `${backendPublicUrl()}/api/download/signed/${signBlobUploadToken(key, contentType, size, expiresIn)}`;
  }
  async signedUrl(key: string, expiresIn: number, downloadFilename?: string): Promise<string> {
    fsPathFor(key);
    const filename = downloadFilename ?? normalizeDownloadFilename(path.posix.basename(key));
    return `${backendPublicUrl()}/api/download/signed/${signBlobToken(key, filename, expiresIn)}`;
  }
}

/**
 * Stream a request body straight onto disk for the filesystem driver's signed
 * PUT route. Streaming (rather than an express body parser) is what keeps a
 * multi-hundred-megabyte upload from being buffered in the process.
 * Rejects before any byte beyond the capability's signed limit reaches disk.
 * The request remains readable after rejection so the route can return its
 * validation response instead of resetting the HTTP connection.
 */
export class BlobUploadSizeError extends Error {
  constructor() {
    super("Upload size does not match the link");
    this.name = "BlobUploadSizeError";
  }
}

export async function writeBlobFromStream(
  key: string,
  body: Readable,
  maxBytes: number,
): Promise<number> {
  if (requireProvider("stream upload").kind !== "fs") {
    throw new Error("writeBlobFromStream is only available on the fs driver");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new BlobUploadSizeError();
  }
  const target = fsPathFor(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Stream into a sibling temp file and rename on success, so an aborted or
  // oversized upload never truncates a blob already stored at this key and
  // never leaves a partial file behind for any caller.
  const temp = `${target}.${randomUUID()}.part`;
  const handle = await fs.open(temp, "wx");
  let committed = false;
  let written = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > maxBytes - written) {
        callback(new BlobUploadSizeError());
        return;
      }
      written += chunk.length;
      callback(null, chunk);
    },
  });
  const abort = (error: Error) => bounded.destroy(error);
  const aborted = () => bounded.destroy(new Error("Upload aborted"));
  const closed = () => {
    if (!body.readableEnded) aborted();
  };
  body.once("error", abort);
  body.once("aborted", aborted);
  body.once("close", closed);
  try {
    if (body.destroyed) throw new Error("Upload aborted");
    const sink = handle.createWriteStream();
    const completed = pipeline(bounded, sink);
    body.pipe(bounded);
    await completed;
    if (written !== maxBytes) throw new BlobUploadSizeError();
    await fs.rename(temp, target);
    committed = true;
  } finally {
    body.unpipe(bounded);
    body.off("error", abort);
    body.off("aborted", aborted);
    body.off("close", closed);
    // Drain a rejected request without writing it. Keeping the incoming HTTP
    // stream out of pipeline lets Express send the expected 400 response.
    if (!body.readableEnded && !body.destroyed) body.resume();
    await handle.close().catch(() => {});
    if (!committed) await fs.rm(temp, { force: true }).catch(() => {});
  }
  return written;
}

/** Remove a partially written blob after a failed or oversized upload. */
export async function discardBlob(key: string): Promise<void> {
  if (requireProvider("discard blob").kind !== "fs") return;
  await fs.rm(fsPathFor(key), { force: true }).catch(() => {});
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createProvider(): StorageProvider {
  if (process.env.STORAGE_DRIVER === "fs") return new FilesystemProvider();
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

// "The object is not there" is the outcome a delete asks for, but only the
// store's own answer to that effect may count. S3, R2 and MinIO answer a
// DeleteObject on a missing key with 204; an S3-compatible store that answers
// 404 instead names the reason in the body, and the SDK surfaces that as
// `NoSuchKey`. A 404 WITHOUT that code (the SDK calls it "NotFound") is what
// a wrong endpoint, a proxy path or a bucket-level 404 produce while the
// object may well still exist. Treating it as success would let the durable
// cleanup jobs (dbq/storageCleanup, documents.cleanupJobs, user.dataCleanup)
// record the key as deleted, stop retrying, and leave the bytes behind for
// good, so anything other than NoSuchKey stays a failure.
function isMissingObject(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NoSuchKey";
}

export async function deleteFile(key: string): Promise<void> {
  // Mutating op: an unconfigured provider must fail loudly (see AGENTS.md).
  const provider = requireProvider("delete");
  // An empty key names no object. Sent anyway, the SDK either rejects it
  // (a missing URI label) or, on some stores, addresses the bucket itself.
  if (!key) return;
  try {
    await provider.remove(key);
  } catch (error) {
    if (isMissingObject(error)) return;
    if (error instanceof StorageOperationError) throw error;
    // Same shape as HEAD/copy/download failures: the operation is named and
    // the SDK error is the cause, where the Sentry privacy boundary reads
    // storage_operation and failure_code.
    throw new StorageOperationError("delete", { cause: error });
  }
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
  return deleteFilesBestEffort([key], stage);
}

/**
 * Best-effort delete of several objects that belong to ONE operation (an
 * upload's staging and sealed copies). Every key is attempted, but the
 * operation reports at most one warning: when storage is unreachable or the
 * credentials are wrong, every key fails for the same reason, and one event
 * per key only multiplies the noise (MIKE-BACKEND-5/6 arrived in pairs).
 * Null/empty keys are skipped: there is nothing to delete.
 */
export function deleteFilesBestEffort(
  keys: ReadonlyArray<string | null | undefined>,
  stage: string,
): Promise<void | undefined> {
  const targets = keys.filter((key): key is string => !!key);
  if (targets.length === 0) return Promise.resolve();
  const work = Promise.allSettled(targets.map((key) => deleteFile(key))).then(
    (results) => {
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    },
  );
  return bestEffort(work, {
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
