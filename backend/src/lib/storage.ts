/**
 * Object storage facade for Mike document management.
 *
 * The transport lives behind the StorageAdapter interface
 * (./storage/adapter.ts); the default is the S3-protocol adapter
 * (./storage/s3.ts — Cloudflare R2, RustFS, MinIO). This module owns the
 * policy every backend shares: not-configured degradation (reads return
 * null/empty, writes throw), error logging, StorageOperationError wrapping,
 * Content-Disposition building, the storage-key layout, and (multi-tenant
 * issue 010) which tenant location and object key a caller's key maps to.
 *
 * Deployments on a different object store implement StorageAdapter in one
 * file and call setStorageAdapter() at boot; no call sites change.
 */

import { AppError, type ErrorKind } from "./appError";
import { bestEffort } from "./observability/sentry";
import { createConfiguredStorageFactory, type ConfiguredStorageFactory } from "./storage/configured";
import { StorageCopyInvariantError } from "./storage/adapter";
import { Readable } from "node:stream";
import type {
  StorageAdapter,
  StoredObjectMetadata,
} from "./storage/adapter";
import { createS3StorageAdapter } from "./storage/s3";
import { createFilesystemStorageAdapter } from "./storage/filesystem";
import { createAzureBlobStorageAdapter } from "./storage/azure";
import { buildContentDisposition } from "./storage/filenames";
import { safeErrorLog } from "./safeError";
import { currentTenant, installTenantId } from "./tenantContext";
import { tenantStorageLocation, type TenantStorageLocation } from "./tenantStorageLocation";
import { storageReadTimeoutMs } from "./storage/timeouts";
export { BlobUploadSizeError } from "./storage/filesystem";
export {
  buildContentDisposition,
  encodeRFC5987,
  normalizeDownloadFilename,
  sanitizeDispositionFilename,
} from "./storage/filenames";

export type { StorageAdapter, StoredObjectMetadata } from "./storage/adapter";

let adapter: StorageAdapter = process.env.STORAGE_DRIVER === "fs"
  ? createFilesystemStorageAdapter()
  : createS3StorageAdapter();

export let storageEnabled = adapter.enabled;
let adapterGeneration = 0;
let initialization: Promise<void> | undefined;
/**
 * Builds adapters for tenant containers on the install's credentials, which
 * initStorage resolved once outside any tenant scope (issue 010). Unset when
 * the adapter was injected rather than configured.
 */
let configuredFactory: ConfiguredStorageFactory | undefined;

/** Await before API listening, worker claims, or CLI storage work. */
export function initStorage(): Promise<void> {
  if (!initialization) {
    const generation = adapterGeneration;
    initialization = createConfiguredStorageFactory().then((factory) => {
      // An explicit injected adapter wins over an in-flight default bootstrap.
      if (adapterGeneration === generation) {
        setStorageAdapter(factory());
        configuredFactory = factory;
      }
    });
  }
  return initialization;
}

/** Replace the storage backend. Call before the first request is served. */
export function setStorageAdapter(next: StorageAdapter): void {
  adapterGeneration++;
  adapter = next;
  storageEnabled = next.enabled;
  // Tenant locations are derived from the install's configuration.
  configuredFactory = undefined;
  resetTenantStorageProviders();
}

const STORAGE_FAILURE_KIND = {
  HEAD: "storage.head_failed",
  copy: "storage.copy_failed",
  "source changed": "storage.copy_failed",
  "copy verification": "storage.copy_failed",
  upload: "storage.upload_failed",
  "stage part transport": "storage.upload_failed",
  "stage part": "storage.upload_failed",
  "seal parts transport": "storage.upload_failed",
  "commit parts": "storage.upload_failed",
  "missing staging ETag": "storage.copy_failed",
  download: "storage.download_failed",
  delete: "storage.delete_failed",
} as const satisfies Record<string, ErrorKind>;

export type StorageOperation = keyof typeof STORAGE_FAILURE_KIND;

/** Retain Dev's conditional-copy operation names and the original SDK cause. */
export class StorageOperationError extends AppError {
  constructor(readonly operation: StorageOperation, options?: { cause?: unknown }) {
    super(STORAGE_FAILURE_KIND[operation], `Object storage ${operation} failed`, options);
  }
}

/**
 * A storage failure this facade absorbs: the caller gets null, as it does
 * when storage is not configured, so nothing above reports it. Report it
 * here, once, with the operation (and the SDK's code via the cause) on the
 * event, then log the SAME object: the console bridge recognises a reported
 * error and files no second, context-free "Failure in application".
 */
function requireStorageConfig(): void {
  if (!adapter.enabled) {
    throw new Error(adapter.configurationHint);
  }
}

/**
 * Fail closed for workflows where treating an unconfigured object store as an
 * empty/successful operation would discard the only durable deletion pointer.
 */
export function assertStorageConfigured(): void {
  requireStorageConfig();
}

// ---------------------------------------------------------------------------
// Tenant routing (multi-tenant issue 010)
// ---------------------------------------------------------------------------
//
// WHERE an object lives comes from the tenant context, never from the key:
//
//   - The adapter is `storageFor(tenant)`: the tenant's registered account
//     and container (tenants.storage_account / storage_container, written by
//     the control plane), else the install's configured location.
//   - Keys callers pass are unchanged (`documents/{user}/…`). For the
//     install's own tenant they are used as-is, so a single-tenant install
//     keeps today's layout and needs no data copy. Every other tenant's
//     objects live under `t/{tenantId}/`, added and stripped here, so call
//     sites and stored storage_path values stay upstream-shaped.
//   - A key already of the form `t/{x}/…` must name the current tenant; any
//     other tenant's key is refused before any storage call.
//   - Work outside a tenant scope runs as the install tenant (single-tenant
//     installs: scripts, platform sweeps). A pooled stamp has no install
//     tenant, so there such work is refused: mutating ops throw, reads find
//     nothing.
//   - Platform-shared objects (the global workflow catalog, the CourtListener
//     cache) stay in the install's configured location for every tenant.
//     Only platform work or the install tenant may write them.
//   - Filesystem-driver capabilities (writeBlobFromStream/discardBlob) carry
//     the object key resolved when they were minted, so they are redeemed
//     on the install's adapter as-is.

const SHARED_PREFIXES = ["mike-workflows/", "courtlistener/"] as const;
const TENANT_KEY = /^t\/([^/]*)\//;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Access = "read" | "write";

interface ResolvedObject {
  adapter: StorageAdapter;
  /** The object key in that adapter. */
  key: string;
  /** Prefix added for this tenant (stripped again from listings), if any. */
  added: string;
  /** For listings: the tenant whose `t/` keys may be returned. */
  tenantId?: string;
}

/** A key or tenant refused by the routing rules above, before any storage call. */
export class TenantStorageError extends AppError {
  constructor(reason: string) {
    super("storage.tenant_check_failed", `Object storage tenant check (${reason}) failed`);
    this.name = "TenantStorageError";
  }
}

const _tenantAdapters = new Map<string, StorageAdapter>();
let _registryFallbackLogged = false;

async function installTenant(): Promise<string | undefined> {
  try {
    return await installTenantId();
  } catch {
    return undefined;
  }
}

function isSharedKey(key: string): boolean {
  return SHARED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function adapterAt(location: TenantStorageLocation | null, op: string): StorageAdapter {
  requireStorageConfig();
  const account = location?.account ?? null;
  const container = location?.container ?? null;
  if (!account && !container) return adapter;
  const cacheKey = `${account ?? ""}/${container ?? ""}`;
  let built = _tenantAdapters.get(cacheKey);
  if (!built) {
    if (account) {
      // A registered account is always reached with the app's managed
      // identity, never with the install's connection string or keys.
      built = createAzureBlobStorageAdapter({
        accountName: account,
        containerName: container ?? process.env.AZURE_STORAGE_CONTAINER_NAME,
      });
    } else if (configuredFactory) {
      // A container alone stays on the install's account/endpoint credentials.
      built = configuredFactory({ containerName: container! });
    } else {
      // An injected adapter has no configuration to derive a container from.
      throw new Error(`Storage location unavailable (cannot ${op})`);
    }
    _tenantAdapters.set(cacheKey, built);
  }
  return built;
}

async function adapterForTenant(tenantId: string, isInstall: boolean, op: string): Promise<StorageAdapter> {
  let location: TenantStorageLocation | null;
  try {
    location = await tenantStorageLocation(tenantId);
  } catch (error) {
    // Another tenant fails closed rather than land in the install's account.
    if (!isInstall) throw new Error(`Storage location unavailable (cannot ${op})`, { cause: error });
    // The install tenant keeps today's configured location when the registry
    // cannot be read (database before the storage-location migration,
    // hosted supabase, no database).
    if (!_registryFallbackLogged) {
      _registryFallbackLogged = true;
      console.warn("[storage] tenant storage location unavailable; using the configured location", {
        error: safeErrorLog(error),
      });
    }
    location = null;
  }
  return adapterAt(location, op);
}

/**
 * The storage adapter for `tenantId`: its registered account/container, or
 * the install's configured location when it has none. Cached per location.
 * Throws when storage is unconfigured or the registry cannot be read for a
 * tenant other than the install's.
 */
export async function storageFor(tenantId: string): Promise<StorageAdapter> {
  return adapterForTenant(tenantId, tenantId === (await installTenant()), "use storage");
}

/** Test seam: forget adapters built for tenant locations. */
export function resetTenantStorageProviders(): void {
  _tenantAdapters.clear();
  _registryFallbackLogged = false;
}

/**
 * Map a caller's key to the adapter and object key for the current tenant.
 * Every check that can refuse runs before the registry lookup and before
 * any storage call.
 */
async function resolveObject(key: string, access: Access, op: string): Promise<ResolvedObject> {
  const install = await installTenant();
  const tenantId = currentTenant()?.tenantId ?? install;

  if (isSharedKey(key)) {
    const platformWork = !currentTenant() || tenantId === install;
    if (access === "write" && !platformWork) throw new TenantStorageError("shared object");
    return { adapter, key, added: "" };
  }

  if (!tenantId) {
    throw new Error(`Storage is not available outside a tenant (cannot ${op})`);
  }
  if (!TENANT_ID.test(tenantId)) throw new TenantStorageError("tenant id");
  const isInstall = tenantId === install;

  let objectKey = key;
  let added = "";
  const owner = TENANT_KEY.exec(key);
  if (owner) {
    if (owner[1] !== tenantId) throw new TenantStorageError("foreign key");
  } else if (key.startsWith("t/") || key === "t") {
    throw new TenantStorageError("malformed key");
  } else if (!isInstall) {
    // Unprefixed (legacy-layout) keys belong only to the install tenant.
    added = `t/${tenantId}/`;
    objectKey = `${added}${key}`;
  }

  const target = await adapterForTenant(tenantId, isInstall, op);
  return { adapter: target, key: objectKey, added, tenantId };
}

/**
 * Read-op variant: a key the routing rules refuse (another tenant's `t/`
 * key, a malformed key) finds nothing instead. Every other failure — no
 * tenant on a pooled stamp, an unreadable location registry — is
 * misconfiguration, not absence, and propagates like main's transport
 * errors: callers such as durable cleanup must not read it as "empty".
 */
async function resolveForRead(key: string, op: string): Promise<ResolvedObject | null> {
  try {
    return await resolveObject(key, "read", op);
  } catch (error) {
    if (error instanceof TenantStorageError) return null;
    throw error;
  }
}

/**
 * Copy between two adapters (a shared catalog object into a tenant's own
 * location): bytes through this process, the source ETag still enforced.
 */
async function copyAcross(
  source: ResolvedObject,
  target: ResolvedObject,
  sourceEtag: string | undefined,
): Promise<void> {
  const meta = await source.adapter.headFile(source.key);
  if (!meta) throw new StorageOperationError("copy");
  if (sourceEtag && meta.etag !== sourceEtag) throw new StorageOperationError("source changed");
  const bytes = await source.adapter.downloadFile(source.key);
  if (!bytes) throw new StorageOperationError("download");
  await target.adapter.uploadFile(target.key, bytes, meta.contentType ?? "application/octet-stream");
  const copied = await target.adapter.headFile(target.key);
  if (!copied || copied.size !== meta.size) throw new StorageOperationError("copy verification");
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
//
// Every helper below resolves the current tenant's adapter and object key
// through resolveObject (issue 010). Mutating ops throw on a refusal; read
// ops (download, list, signed URL) return null / [] instead.

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  const target = await resolveObject(key, "write", "upload");
  await target.adapter.uploadFile(target.key, content, contentType);
}

export async function uploadFileFromPath(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  const target = await resolveObject(key, "write", "upload");
  try {
    await target.adapter.uploadFileFromPath(target.key, filePath, contentType);
  } catch (error) {
    throw new StorageOperationError("upload", { cause: error });
  }
}

/**
 * Presign a single direct browser `PUT`. The declared content type and byte
 * count are part of the signature, so the URL cannot be replayed with a
 * different body: the browser sets `Content-Length` from the body itself, and
 * any other size fails signature validation at the store.
 */
export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expectedSizeBytes: number,
  expiresIn = 900,
): Promise<string | null> {
  if (!adapter.enabled) return null;
  const target = await resolveObject(key, "write", "sign upload");
  try {
    return await target.adapter.getSignedUploadUrl(
      target.key,
      contentType,
      expectedSizeBytes,
      expiresIn,
    );
  } catch (error) {
    // Thrown once with the SDK's own code on the cause; the route that
    // answers reports it. Logging and returning null here filed the failure
    // twice: once from storage, once from the caller's cause-less throw.
    throw new AppError(
      "storage.signed_url_failed",
      "Object storage signed upload URL failed",
      { cause: error },
    );
  }
}

export async function headFile(
  key: string,
): Promise<StoredObjectMetadata | null> {
  // Dev: a missing configuration is not evidence an upload/blob is absent.
  requireStorageConfig();
  const source = await resolveObject(key, "read", "HEAD");
  try {
    return await source.adapter.headFile(source.key);
  } catch (error) {
    // Thrown, not logged: the caller that catches this reports it, and a
    // console line here filed the same failure a second time.
    throw new StorageOperationError("HEAD", { cause: error });
  }
}

export async function copyFile(
  sourceKey: string,
  targetKey: string,
  sourceEtag?: string,
): Promise<void> {
  requireStorageConfig();
  const source = await resolveObject(sourceKey, "read", "copy");
  const target = await resolveObject(targetKey, "write", "copy");
  try {
    if (source.adapter !== target.adapter) {
      await copyAcross(source, target, sourceEtag);
    } else if (sourceEtag === undefined) {
      await target.adapter.copyFile(source.key, target.key);
    } else {
      await target.adapter.copyFile(source.key, target.key, sourceEtag);
    }
  } catch (error) {
    if (error instanceof StorageOperationError) throw error;
    if (error instanceof StorageCopyInvariantError) {
      throw new StorageOperationError(error.operation, { cause: error });
    }
    throw new StorageOperationError("copy", { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  if (!adapter.enabled) return null;
  const source = await resolveForRead(key, "download");
  if (!source) return null;
  try {
    return signal
      ? await source.adapter.downloadFile(source.key, signal)
      : await source.adapter.downloadFile(source.key);
  } catch (error) {
    // null is "not there" (the adapters translate a missing object); a
    // transport or permission failure is thrown so the caller's handler
    // reports it once, with the store's own code on the cause.
    throw new StorageOperationError("download", { cause: error });
  }
}

/**
 * Read an object the caller can go on without: a cached rendition, an
 * optional PDF copy, a fallback source. null for an object that is not
 * there, and null for a failure too, which is reported once here as a
 * warning with the store's code, because the caller will carry on and
 * nothing else would file it. A read the caller cannot do without uses
 * downloadFile, whose failure propagates to the handler that reports it.
 */
export async function downloadFileIfAvailable(
  key: string,
): Promise<ArrayBuffer | null> {
  return (await bestEffort(downloadFile(key), { what: "optional-read" })) ?? null;
}

/**
 * Lazily stream an object from the store. The read starts only when a consumer
 * reads from the returned stream, allowing archive writers to apply
 * backpressure without buffering whole files or opening every object
 * concurrently.
 */
export function createFileReadStream(key: string): Readable {
  return Readable.from(
    (async function* () {
      requireStorageConfig();
      // A refused key surfaces as its own error, not as a download failure.
      const source = await resolveObject(key, "read", "download");
      try {
        const body = await source.adapter.openReadStream(source.key);
        if (!body) {
          throw new StorageOperationError("download");
        }
        for await (const chunk of body) {
          yield chunk;
        }
      } catch (error) {
        // Thrown, not logged (see headFile).
        if (error instanceof StorageOperationError) throw error;
        throw new StorageOperationError("download", { cause: error });
      }
    })(),
  );
}

function asDownloadError(error: unknown): StorageOperationError {
  return error instanceof StorageOperationError
    ? error
    : new StorageOperationError("download", { cause: error });
}

/**
 * Wait for one step of a storage read, but never longer than the read timeout
 * and never past an abort. The race settles even when the store has stalled
 * (and its own promise never settles), which is what lets a timed-out or
 * abandoned read be torn down instead of pinning its caller.
 */
function boundedStep<T>(step: Promise<T>, controller: AbortController): Promise<T> {
  // The losing side of the race may reject later; it is already handled.
  step.catch(() => undefined);
  const { signal } = controller;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    const timer = setTimeout(() => {
      controller.abort(
        new DOMException("Object storage read timed out", "TimeoutError"),
      );
    }, storageReadTimeoutMs());
    signal.addEventListener("abort", onAbort, { once: true });
    step.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Open an object for a streamed response (a download handed straight to the
 * client) without holding the whole object in memory.
 *
 * The object is opened, and its first chunk read, before this resolves, so a
 * store that cannot serve it fails HERE with a StorageOperationError while the
 * caller can still answer with an error status. After that, failures surface
 * as an error on the returned stream.
 *
 * Every wait on the store is bounded by the storage read timeout, and the
 * read is released (the request cancelled, the socket or file closed) when
 * the returned stream is destroyed, the timeout fires, or `signal` aborts.
 * Unlike downloadFile, the timeout bounds each wait on the store rather than
 * the whole transfer, so a slow client applying backpressure is not cut off.
 */
export async function openFileStream(
  key: string,
  options: { signal?: AbortSignal } = {},
): Promise<Readable> {
  requireStorageConfig();
  // Dev (multi-tenant 010): route the key to the current tenant's location;
  // a refused key surfaces as its own error, as in createFileReadStream.
  const source = await resolveObject(key, "read", "download");
  const controller = new AbortController();
  const outer = options.signal;
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward, { once: true });
  const release = () => {
    controller.abort();
    outer?.removeEventListener("abort", forward);
  };

  let iterator: AsyncIterator<Uint8Array>;
  let first: IteratorResult<Uint8Array>;
  try {
    const body = await boundedStep(
      source.adapter.openReadStream(source.key, { signal: controller.signal }),
      controller,
    );
    if (!body) throw new StorageOperationError("download");
    iterator = body[Symbol.asyncIterator]();
    first = await boundedStep(iterator.next(), controller);
  } catch (error) {
    release();
    // Thrown, not logged (see headFile).
    throw asDownloadError(error);
  }

  let pending: IteratorResult<Uint8Array> | null = first;
  return new Readable({
    read() {
      const step = pending
        ? Promise.resolve(pending)
        : boundedStep(iterator.next(), controller);
      pending = null;
      step.then(
        (result) => {
          if (this.destroyed) return;
          this.push(result.done ? null : result.value);
        },
        (error) => {
          if (!this.destroyed) this.destroy(asDownloadError(error));
        },
      );
    },
    destroy(error, callback) {
      // Abort first: a store that is mid-read only lets go when its signal
      // fires, and return() on an iterator with a pending next() would wait
      // for that read to finish.
      release();
      iterator.return?.().catch(() => undefined);
      callback(error);
    },
  });
}

/**
 * Read operation — returns [] when storage is unconfigured or the prefix is
 * refused (another tenant's); a missing tenant or an unreadable location
 * throws (see resolveForRead). Keys come back
 * in the caller's form: the tenant prefix added on the way in is stripped,
 * and the install tenant never sees another tenant's `t/` keys.
 */
export async function listFiles(prefix: string): Promise<string[]> {
  if (!adapter.enabled) return [];
  const scope = await resolveForRead(prefix, "list");
  if (!scope) return [];
  const keys = await scope.adapter.listFiles(scope.key);
  const own = scope.tenantId ? `t/${scope.tenantId}/` : null;
  return keys.flatMap((key) => {
    if (scope.added) return key.startsWith(scope.added) ? [key.slice(scope.added.length)] : [];
    if (key.startsWith("t/") && (!own || !key.startsWith(own))) return [];
    return [key];
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  // Upstream divergence (sync-log: 80136892): durable cleanup must keep retrying
  // when storage is unconfigured; an optional/no-op delete loses its pointer.
  requireStorageConfig();
  // An empty key names no object. Sent anyway, the SDK either rejects it
  // (a missing URI label) or, on some stores, addresses the bucket itself.
  if (!key) return;
  const target = await resolveObject(key, "write", "delete");
  try {
    // The adapter resolves when the store itself says the object is already
    // gone (see deleteFile in ./storage/adapter.ts), so reaching this catch
    // means the delete genuinely failed.
    await target.adapter.deleteFile(target.key);
  } catch (error) {
    // Same shape as HEAD/copy/download failures: the operation is named and
    // the SDK error (with its errno or S3 code) is the cause, which is where
    // the Sentry privacy boundary reads storage_operation and failure_code.
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
    what: stage,
    tags: { component: "storage", stage, storage_operation: "delete" },
  });
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!adapter.enabled) return null;
  const source = await resolveForRead(key, "sign URL");
  if (!source) return null;
  try {
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the storage
    // key (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    return await source.adapter.getSignedUrl(
      source.key,
      expiresIn,
      responseContentDisposition,
      downloadFilename,
    );
  } catch (error) {
    throw new AppError(
      "storage.signed_url_failed",
      "Object storage signed URL failed",
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

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


// ---------------------------------------------------------------------------
// Streamed signed uploads (filesystem driver)
// ---------------------------------------------------------------------------

/**
 * Redeem a backend-minted upload capability by streaming the request body
 * into storage. Only the filesystem driver mints those capabilities (an S3
 * store takes the browser's presigned PUT directly), so a transport without
 * writeBlobFromStream rejects the call rather than silently dropping bytes.
 *
 * Multi-tenant: the capability names the object key getSignedUploadUrl
 * resolved for its tenant when it was minted, and is redeemed without a
 * tenant context, so the key is used as-is on the install's adapter.
 */
export async function writeBlobFromStream(
  key: string,
  body: Readable,
  maxBytes: number,
): Promise<number> {
  requireStorageConfig();
  if (!adapter.writeBlobFromStream) {
    throw new Error("writeBlobFromStream is only available on the fs driver");
  }
  return adapter.writeBlobFromStream(key, body, maxBytes);
}

/** Remove a partially written blob after a failed or oversized upload. */
export async function discardBlob(key: string): Promise<void> {
  requireStorageConfig();
  await adapter.discardBlob?.(key);
}

/**
 * Dev's private Blob upload flow stays behind the same adapter seam. The
 * install's adapter decides the transport; tenant locations keep that kind
 * (a registered account is Azure, used on Azure installs).
 */
export function uploadTransport(): "direct" | "authenticated_parts" {
  requireStorageConfig();
  return adapter.uploadTransport ?? "direct";
}

export async function stageUploadPart(
  key: string, blockId: string, body: Readable, length: number, signal?: AbortSignal,
): Promise<void> {
  requireStorageConfig();
  const target = await resolveObject(key, "write", "stage part");
  if (target.adapter.uploadTransport !== "authenticated_parts" || !target.adapter.stageUploadPart) {
    throw new StorageOperationError("stage part transport");
  }
  try {
    await target.adapter.stageUploadPart(target.key, blockId, body, length, signal);
  } catch (error) {
    throw new StorageOperationError("stage part", { cause: error });
  }
}

export async function sealUploadParts(key: string, blockIds: string[], contentType: string): Promise<void> {
  requireStorageConfig();
  const target = await resolveObject(key, "write", "seal parts");
  if (target.adapter.uploadTransport !== "authenticated_parts" || !target.adapter.sealUploadParts) {
    throw new StorageOperationError("seal parts transport");
  }
  try {
    await target.adapter.sealUploadParts(target.key, blockIds, contentType);
  } catch (error) {
    throw new StorageOperationError("commit parts", { cause: error });
  }
}
