/** Boot composition for the upstream StorageAdapter seam (no app/module imports). */
import { resolveProviderSecret } from "../envSecrets";
import type { StorageAdapter } from "./adapter";
import { createAzureBlobStorageAdapter } from "./azure";
import { createFilesystemStorageAdapter } from "./filesystem";
import { createS3StorageAdapter } from "./s3";

/**
 * Use the existing explicit vault-first boundary. Check custom/canonical vault
 * names before any environment fallback; never reorder legacy getConfig.
 */
async function storageSecret(envName: string, canonicalName: string): Promise<string> {
  const customName = process.env[`${envName}_SECRET_NAME`]?.trim();
  const names = [...new Set([customName, canonicalName].filter((name): name is string => !!name))];
  return resolveProviderSecret(names[0]!, names.slice(1));
}

/**
 * Builds adapters on the install's resolved storage credentials.
 * `containerName` (multi-tenant issue 010): a tenant's registered container
 * (bucket on S3) on the install's account/endpoint credentials. Omitted: the
 * configured container. The filesystem driver ignores it.
 */
export type ConfiguredStorageFactory = (location?: { containerName?: string }) => StorageAdapter;

/**
 * Resolve the install's storage credentials once (at boot, outside any
 * tenant scope) and return a factory over them, so tenant container
 * adapters never re-resolve credentials inside a tenant's context.
 */
export async function createConfiguredStorageFactory(): Promise<ConfiguredStorageFactory> {
  if (process.env.STORAGE_DRIVER === "fs") {
    const fsAdapter = createFilesystemStorageAdapter();
    return () => fsAdapter;
  }

  const connectionString = await storageSecret(
    "AZURE_STORAGE_CONNECTION_STRING", "azure-storage-connection-string",
  );
  if (process.env.AZURE_STORAGE_ACCOUNT_NAME || connectionString) {
    return (location = {}) => createAzureBlobStorageAdapter({
      accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
      connectionString: connectionString || undefined,
      containerName: location.containerName ?? process.env.AZURE_STORAGE_CONTAINER_NAME,
    });
  }

  const [accessKeyId, secretAccessKey] = await Promise.all([
    storageSecret("R2_ACCESS_KEY_ID", "r2-access-key-id"),
    storageSecret("R2_SECRET_ACCESS_KEY", "r2-secret-access-key"),
  ]);
  return (location = {}) => createS3StorageAdapter({
    endpoint: process.env.R2_ENDPOINT_URL,
    publicEndpoint: process.env.R2_PUBLIC_ENDPOINT_URL,
    bucketName: location.containerName ?? process.env.R2_BUCKET_NAME,
    accessKeyId: accessKeyId || undefined,
    secretAccessKey: secretAccessKey || undefined,
  });
}

/**
 * Await once at boot, then setStorageAdapter(result) before API listening or
 * worker claiming. The facade's disabled initial adapter preserves auth-only
 * startup degradation; these factories never perform object-store probes.
 */
export async function createConfiguredStorageAdapter(): Promise<StorageAdapter> {
  return (await createConfiguredStorageFactory())();
}
