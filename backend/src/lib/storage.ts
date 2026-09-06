import path from "node:path";
import { sqliteStorageProvider } from "./storage/sqlite";
import type { StorageProvider } from "./storage/types";

export {
  buildContentDisposition,
  encodeRFC5987,
  normalizeDownloadFilename,
  sanitizeDispositionFilename,
} from "./storage/filenames";

export const STORAGE_PROVIDERS = ["sqlite"] as const;
export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];

export function resolveStorageProvider(
  env: NodeJS.ProcessEnv = process.env,
): StorageProviderName {
  const configured = env.MIKE_STORAGE_PROVIDER?.trim().toLowerCase();
  if (configured && configured !== "sqlite") {
    throw new Error(
      `Unsupported MIKE_STORAGE_PROVIDER "${configured}". This fork uses SQLite storage.`,
    );
  }
  return "sqlite";
}

export function createStorageProvider(): StorageProvider {
  resolveStorageProvider();
  return sqliteStorageProvider;
}

function provider(): StorageProvider {
  return createStorageProvider();
}

export const storageEnabled = provider().enabled;

export async function uploadFile(
  key: string,
  content: ArrayBuffer | ArrayBufferView,
  contentType: string,
): Promise<void> {
  return provider().uploadFile(key, content, contentType);
}

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  return provider().downloadFile(key);
}

export async function listFiles(prefix: string): Promise<string[]> {
  return provider().listFiles(prefix);
}

export async function deleteFile(key: string): Promise<void> {
  return provider().deleteFile(key);
}

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  return provider().getSignedUrl(key, expiresIn, downloadFilename);
}

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

export function workflowReferenceKey(
  userId: string,
  workflowId: string,
  referenceId: string,
  contentHash: string,
  filename: string,
): string {
  return `workflow-references/${userId}/${workflowId}/${referenceId}/${contentHash}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : fallback;
}
