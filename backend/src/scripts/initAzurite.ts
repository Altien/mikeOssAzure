// Creates the blob container the backend expects in local Azurite. Azurite
// starts empty, so the first upload 500s without this. Idempotent. Run via
// `pnpm azurite:init`. Replaces the manual `node -e "...createIfNotExists..."`.
import { BlobServiceClient } from "@azure/storage-blob";

async function main(): Promise<void> {
  const conn =
    process.env.AZURE_STORAGE_CONNECTION_STRING ?? "UseDevelopmentStorage=true";
  const container = process.env.AZURE_STORAGE_CONTAINER_NAME ?? "documents";
  await BlobServiceClient.fromConnectionString(conn)
    .getContainerClient(container)
    .createIfNotExists();
  console.log(`[azurite] container '${container}' ready`);
}

main().catch((err) => {
  console.error(
    "[azurite] failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
