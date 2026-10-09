import { createServerSupabase } from "../lib/supabase";
import { flushSentry, reportError } from "../lib/observability/sentry";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";
import { resolveProviderSecret } from "../lib/envSecrets";

async function main() {
  const githubToken = await resolveProviderSecret("mike-workflows-github-token");
  const result = await syncWorkflowCatalog(
    createServerSupabase(),
    githubToken ? { githubToken } : {},
  );
  console.log(
    `Synced ${result.workflows} Mike workflows and ${result.assets} assets from ${result.sourceCommit}`,
  );
}

void main().catch(async (error) => {
  reportError(error, { tags: { component: "workflow-sync" }, level: "fatal" });
  console.error("Mike workflow sync failed", error);
  await flushSentry();
  process.exit(1);
});
