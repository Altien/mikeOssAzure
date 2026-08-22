import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";
import { resolveProviderSecret } from "../lib/envSecrets";

async function main() {
  const githubToken = await resolveProviderSecret("mike-workflows-github-token");
  const result = await syncWorkflowCatalog(
    createServerSupabase(),
    githubToken ? { githubToken } : {},
  );
  console.log(
    `Synced ${result.workflows} Mike workflows and ${result.references} reference files from ${result.sourceCommit}`,
  );
}

void main().catch((error) => {
  console.error("Mike workflow sync failed", error);
  process.exit(1);
});
