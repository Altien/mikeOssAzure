import "dotenv/config";
import { createServerDatabase } from "../lib/database";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";

async function main() {
  const result = await syncWorkflowCatalog(createServerDatabase());
  console.log(
    `Synced ${result.workflows} Mike workflows and ${result.references} reference files from ${result.sourceCommit}`,
  );
}

void main().catch((error) => {
  console.error("Mike workflow sync failed", error);
  process.exit(1);
});
