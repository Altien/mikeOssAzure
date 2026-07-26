import { createServerSupabase } from "../../lib/supabase";
import { GitHubSkillImportError, checkGitHubSourceUpdate } from "./github";
import { getGitHubSkillOAuthToken } from "./githubOAuth";
import { getGitHubSkillImportPolicy } from "./settings";

type Db = ReturnType<typeof createServerSupabase>;

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
  const version = await db
    .from("altien_skill_versions")
    .select("id, snapshot_id, skill_id")
    .eq("id", args.versionId)
    .single();
  if (version.error || !version.data) throw new Error("Skill version not found.");
  const skill = await db
    .from("altien_skills")
    .select("id")
    .eq("id", version.data.skill_id)
    .eq("tenant_id", args.tenantId)
    .is("deleted_at", null)
    .single();
  if (skill.error || !skill.data) throw new Error("Skill version not found.");
  const snapshot = await db
    .from("altien_skill_import_snapshots")
    .select(
      "source_kind, github_repository, github_selected_path, github_requested_ref, github_resolved_commit_sha",
    )
    .eq("id", version.data.snapshot_id)
    .eq("tenant_id", args.tenantId)
    .single();
  if (
    snapshot.error ||
    !snapshot.data ||
    snapshot.data.source_kind !== "github"
  ) {
    throw new Error("This skill version was not imported from GitHub.");
  }
  return checkGitHubSourceUpdate({
    repository: String(snapshot.data.github_repository),
    selectedPath: String(snapshot.data.github_selected_path ?? ""),
    requestedRef: String(snapshot.data.github_requested_ref),
    lastResolvedCommitSha: String(
      snapshot.data.github_resolved_commit_sha,
    ),
    token: (await getGitHubSkillOAuthToken(args.tenantId, db)) ?? undefined,
    fetcher: args.fetcher,
  });
}

