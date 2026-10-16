/**
 * Private Azure Blob implementation of upstream154's StorageAdapter seam.
 * Credentials are resolved before construction by configured.ts. Account-name
 * deployments use DefaultAzureCredential (Managed Identity/AZURE_CLIENT_ID).
 * Browser transfers stay on authenticated backend routes; never mint SAS URLs.
 */
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { Readable } from "node:stream";
import { StorageCopyInvariantError, type StorageAdapter } from "./adapter";

export type AzureStorageOptions = {
  accountName?: string;
  /** Already resolved Key Vault first, environment fallback. */
  connectionString?: string;
  containerName?: string;
};

function isMissingBlob(error: unknown): boolean {
  const failure = error as { code?: unknown; details?: { errorCode?: unknown } } | null;
  return failure?.code === "BlobNotFound" || failure?.details?.errorCode === "BlobNotFound";
}

export function createAzureBlobStorageAdapter(options: AzureStorageOptions): StorageAdapter {
  const enabled = Boolean(options.connectionString || options.accountName);
  let cachedContainer: ContainerClient | undefined;
  function container(): ContainerClient {
    if (!cachedContainer) {
      const service = options.connectionString
        ? BlobServiceClient.fromConnectionString(options.connectionString)
        : new BlobServiceClient(
            `https://${options.accountName}.blob.core.windows.net`,
            new DefaultAzureCredential(),
          );
      cachedContainer = service.getContainerClient(options.containerName ?? "documents");
    }
    return cachedContainer;
  }

  return {
    enabled,
    configurationHint: "Azure Blob requires AZURE_STORAGE_ACCOUNT_NAME (Managed Identity) or a Key Vault/environment AZURE_STORAGE_CONNECTION_STRING",
    uploadTransport: "authenticated_parts",

    async uploadFile(key, content, contentType) {
      await container().getBlockBlobClient(key).uploadData(Buffer.from(content), {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    },

    async uploadFileFromPath(key, filePath, contentType) {
      // The SDK owns file handles, content length and retry bookkeeping.
      await container().getBlockBlobClient(key).uploadFile(filePath, {
        blobHTTPHeaders: { blobContentType: contentType },
        blockSize: 8 * 1024 * 1024,
        concurrency: 2,
      });
    },

    async getSignedUploadUrl() {
      // The private storage endpoint is unreachable from browsers. Its SAS
      // also cannot bind the exact Content-Length the capability requires.
      return null;
    },

    async downloadFile(key) {
      try {
        const bytes = await container().getBlobClient(key).downloadToBuffer();
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } catch (error) {
        if (isMissingBlob(error)) return null;
        throw error;
      }
    },

    async openReadStream(key) {
      try {
        const response = await container().getBlobClient(key).download(0);
        return (response.readableStreamBody as Readable | undefined) ?? null;
      } catch (error) {
        if (isMissingBlob(error)) return null;
        throw error;
      }
    },

    async headFile(key) {
      try {
        const metadata = await container().getBlobClient(key).getProperties();
        return {
          size: metadata.contentLength ?? 0,
          etag: metadata.etag ?? null,
          contentType: metadata.contentType ?? null,
        };
      } catch (error) {
        // A container/firewall/proxy 404 is not proof that this blob is gone.
        if (isMissingBlob(error)) return null;
        throw error;
      }
    },

    async listFiles(prefix) {
      const keys: string[] = [];
      for await (const blob of container().listBlobsFlat({ prefix })) keys.push(blob.name);
      return keys;
    },

    async copyFile(sourceKey, targetKey, sourceEtag) {
      const source = container().getBlobClient(sourceKey);
      const metadata = await source.getProperties();
      if (sourceEtag && metadata.etag !== sourceEtag) {
        throw new StorageCopyInvariantError("source changed");
      }
      // Do not use server-side copy from a browser SAS. Stream privately with
      // ifMatch covering the actual GET, closing the HEAD-to-GET race.
      const response = await source.download(0, undefined, {
        conditions: { ifMatch: sourceEtag ?? metadata.etag },
      });
      const body = response.readableStreamBody as Readable | undefined;
      if (!body) throw new StorageCopyInvariantError("copy verification");
      try {
        await container().getBlockBlobClient(targetKey).uploadStream(body, 8 * 1024 * 1024, 2, {
          blobHTTPHeaders: { blobContentType: metadata.contentType },
        });
      } finally {
        body.destroy();
      }
      const target = await container().getBlobClient(targetKey).getProperties();
      if (target.contentLength !== metadata.contentLength) {
        throw new StorageCopyInvariantError("copy verification");
      }
    },

    async deleteFile(key) {
      try {
        await container().getBlobClient(key).delete();
      } catch (error) {
        // Cleanup may finalize only on the provider's specific BlobNotFound,
        // never a generic 404 (wrong container, endpoint or network path).
        if (isMissingBlob(error)) return;
        throw error;
      }
    },

    async getSignedUrl() {
      return null; // The facade's callers retain their authenticated proxy fallback.
    },

    async stageUploadPart(key, blockId, body, length, signal) {
      await container().getBlockBlobClient(key).stageBlock(blockId, body, length, { abortSignal: signal });
    },

    async sealUploadParts(key, blockIds, contentType) {
      await container().getBlockBlobClient(key).commitBlockList(blockIds, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifNoneMatch: "*" },
      });
    },
  };
}
