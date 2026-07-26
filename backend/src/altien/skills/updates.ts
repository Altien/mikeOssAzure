import { createServerSupabase } from "../../lib/supabase";
import { GitHubSkillImportError, checkGitHubSourceUpdate } from "./github";
import { getGitHubSkillOAuthToken } from "./githubOAuth";
import { getGitHubSkillImportPolicy } from "./settings";
import { loadSkillVersionContext, type Db } from "./shared";

export async function checkGitHubSkillVersionUpdate(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
  fetcher?: typeof fetch;
}) {
  const db = args.db ?? createServerSupabase();
  // An update check is GitHub skill acquisition: it talks to GitHub with the
  // tenant token. It goes through the same deployment + tenant gates as the
  // import path, and fails with the same structured codes/messages, so an
  // operator who denies GitHub acquisition denies this too.
  const policy = await getGitHubSkillImportPolicy(args.tenantId, db);
  if (!policy.deploymentAllowed) {
    throw new GitHubSkillImportError(
      "github_import_deployment_denied",
      "GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED",
    );
  }
  if (!policy.tenantEnabled) {
    throw new GitHubSkillImportError(
      "github_import_tenant_disabled",
      "GITHUB_SKILL_IMPORT_TENANT_DISABLED",
    );
  }
  const { snapshot } = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  if (snapshot.source_kind !== "github") {
    throw new Error("This skill version was not imported from GitHub.");
  }
  return checkGitHubSourceUpdate({
    repository: String(snapshot.github_repository),
    selectedPath: String(snapshot.github_selected_path ?? ""),
    requestedRef: String(snapshot.github_requested_ref),
    lastResolvedCommitSha: String(snapshot.github_resolved_commit_sha),
    token: (await getGitHubSkillOAuthToken(args.tenantId, db)) ?? undefined,
    fetcher: args.fetcher,
  });
}

