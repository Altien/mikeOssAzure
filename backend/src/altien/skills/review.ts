import { randomUUID } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { getUserModelSettings } from "../../modules/user/user.service";
import {
  analyseSkillInstructions,
  type SkillAnalysisArtifact,
} from "./analysis";
import {
  assertActionIntegrity,
  createAcquireDependencyAction,
  createEnableAction,
  createLinkPriorSkillAction,
  createRenameSkillAction,
  hashActionPayload,
  isAffirmativeAuthorization,
  isRejection,
  parseSkillActionAmendments,
  SKILL_AMENDMENT_SYNTAX,
  type PendingSkillAction,
  type SkillActionAmendment,
} from "./actions";
import { persistSkillRename } from "./artifacts";
import {
  applyCapabilityAmendments,
  firstPartyToolCatalogue,
  labelForTool,
  inspectMcpToolCatalogue,
  resolveCapabilityContractWithLlm,
  STRUCTURAL_GAP_STATUSES,
  type ToolCatalogueItem,
} from "./capabilities";
import {
  dependencyBindings,
  missingDeclaredGitHubDependencies,
  resolvedDependencyBindings,
} from "./dependencies";
import { acquireGitHubSkill } from "./github";
import { resolveSelectedProjectDocuments } from "./invocation";
import { getGitHubSkillOAuthToken } from "./githubOAuth";
import { storeSkillSnapshot } from "./persistence";
import { getGitHubSkillImportPolicy, skillAnalysisModel } from "./settings";
import { SkillResourceStore } from "./resources";
import { getProjectSkillPin } from "./pins";
import {
  loadSkillVersionContext,
  requireResult,
  throwOnDbError,
  type Db,
} from "./shared";

function manifestFile(
  version: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  relativePath: string,
) {
  const manifest = (version.adapted_manifest ?? snapshot.manifest) as
    | { files?: Array<Record<string, unknown>> }
    | undefined;
  const file = manifest?.files?.find((item) => item.path === relativePath);
  if (!file?.document_version_id) {
    throw new Error("Skill entrypoint is missing from its immutable manifest.");
  }
  return file;
}

async function ensureConversation(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  db: Db;
}): Promise<string> {
  const existing = await args.db
    .from("altien_skill_import_conversations")
    .select("id")
    .eq("version_id", args.versionId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  throwOnDbError(existing);
  if (existing.data?.id) return String(existing.data.id);
  const inserted = requireResult<{ id: string }>(
    await args.db
      .from("altien_skill_import_conversations")
      .insert({
        id: randomUUID(),
        tenant_id: args.tenantId,
        version_id: args.versionId,
        created_by: args.userId,
      })
      .select("id")
      .single(),
    "Failed to create skill review conversation.",
  );
  return String(inserted.id);
}

async function addMessage(args: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  actorUserId?: string;
  structuredContent?: unknown;
  db: Db;
}): Promise<string> {
  const id = randomUUID();
  const result = await args.db.from("altien_skill_import_messages").insert({
    id,
    conversation_id: args.conversationId,
    role: args.role,
    actor_user_id: args.actorUserId ?? null,
    content: args.content,
    structured_content: args.structuredContent ?? null,
  });
  throwOnDbError(result);
  return id;
}

/**
 * Versions whose analysis and capability contract may still be rebuilt.
 *
 * An enabled version is immutable: its approved contract is bound to the exact
 * analysis it was reviewed against, by both input and output hash, so
 * re-analysing one in place would leave an approval pointing at findings that
 * no longer exist. Disabling is the way back — it grants nothing and no
 * project can reach it, so there is nothing left to invalidate.
 *
 * This was previously enforced only by the review panel hiding its buttons,
 * which left the route open and left a disabled version with no way forward
 * at all.
 */
const REVIEWABLE_STATES = ["draft", "disabled"];

function assertReviewable(version: { state?: unknown }) {
  const state = String(version.state ?? "");
  if (REVIEWABLE_STATES.includes(state)) return;
  throw new Error(
    `A ${state} version cannot be re-analysed or re-proposed. Disable the skill first; its approved contract is bound to the analysis it was reviewed against.`,
  );
}

export async function analyseSkillVersion(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  db?: Db;
  analyse?: (input: {
    name: string;
    description: string;
    instructions: string;
    deterministicFindings: unknown;
    toolCatalogue?: unknown;
    model: string;
    apiKeys?: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
  }) => Promise<SkillAnalysisArtifact>;
  settings?: typeof getUserModelSettings;
}) {
  const db = args.db ?? createServerSupabase();
  const context = await loadSkillVersionContext({ ...args, db });
  assertReviewable(context.version);
  const running = await db
    .from("altien_skill_versions")
    .update({ analysis_state: "running" })
    .eq("id", args.versionId);
  throwOnDbError(running);
  try {
    const entrypointPath = String(context.version.entrypoint_path);
    const file = manifestFile(context.version, context.snapshot, entrypointPath);
    const documentVersion = requireResult<Record<string, unknown>>(
      await db
        .from("document_versions")
        .select("storage_path")
        .eq("id", String(file.document_version_id))
        .single(),
      "Skill entrypoint document version not found.",
    );
    const bytes = await downloadFile(String(documentVersion.storage_path));
    if (!bytes) throw new Error("Skill entrypoint blob is unavailable.");
    const instructions = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes,
    );
    const settingsLoader = args.settings ?? getUserModelSettings;
    const settings = await settingsLoader(args.userId, db);
    const toolCatalogue = [
      ...firstPartyToolCatalogue(),
      ...(await inspectMcpToolCatalogue(args.userId, db)),
    ];
    const analyser = args.analyse ?? analyseSkillInstructions;
    const artifact = await analyser({
      name: String(context.skill.display_name),
      description: String(context.skill.description),
      instructions,
      deterministicFindings: context.version.deterministic_analysis ?? {},
      toolCatalogue,
      model: skillAnalysisModel(settings.fast_model),
      apiKeys: settings.api_keys,
    });
    const completedAt = new Date().toISOString();
    const saved = await db
      .from("altien_skill_versions")
      .update({
        analysis_state: "succeeded",
        analysis_provider: artifact.provider,
        analysis_model: artifact.model,
        analysis_schema_version: artifact.schemaVersion,
        analysis_input_hash: artifact.inputHash,
        analysis_completed_at: completedAt,
        generated_analysis: artifact.generated,
      })
      .eq("id", args.versionId);
    throwOnDbError(saved);
    await db
      .from("altien_skill_import_snapshots")
      .update({ status: "ready" })
      .eq("id", String(context.snapshot.id));
    const conversationId = await ensureConversation({ ...args, db });
    // An enable proposal is bound to the exact analysis it was built from, so
    // this analysis has just invalidated any outstanding one. Left pending, it
    // captures every affirmative reply — "enable", "yes" — and answers each
    // with "The pending action no longer matches this analysis", with no route
    // forward except knowing to reject it first. Only enable actions are
    // expired: a rename, an acquisition or an identity link carries no
    // analysis hash and this says nothing about them.
    const outstanding = await db
      .from("altien_skill_pending_actions")
      .select("id")
      .eq("version_id", args.versionId)
      .eq("action_type", "enable_version")
      .eq("state", "pending");
    throwOnDbError(outstanding);
    const expiredCount = (outstanding.data ?? []).length;
    if (expiredCount) {
      const expired = await db
        .from("altien_skill_pending_actions")
        .update({ state: "expired" })
        .eq("version_id", args.versionId)
        .eq("action_type", "enable_version")
        .eq("state", "pending");
      throwOnDbError(expired);
    }
    await addMessage({
      conversationId,
      role: "assistant",
      content: [
        "Analysis complete. Review the exact requirements, then tell me to enable this version if they are acceptable.",
        ...(expiredCount
          ? [
              "An earlier enable proposal was built from the previous analysis and no longer applies; it has expired. Nothing was enabled by it.",
            ]
          : []),
      ].join("\n"),
      structuredContent: { type: "analysis", artifact },
      db,
    });
    return { conversationId, artifact };
  } catch (error) {
    await db
      .from("altien_skill_versions")
      .update({ analysis_state: "failed" })
      .eq("id", args.versionId);
    await db
      .from("altien_skill_import_snapshots")
      .update({ status: "analysis_failed" })
      .eq("id", String(context.snapshot.id));
    throw error;
  }
}

type PossibleSkillIdentityMatch = {
  skillId: string;
  canonicalName: string;
  displayName: string;
  matchedOn: string;
};

/**
 * Identity of the findings a contract was reviewed against. Re-analysing the
 * same package — with a different model, or the same one on a different day —
 * changes this, so a pending action built from the old findings stops
 * matching even though the package text is unchanged.
 */
function analysisOutputHash(version: Record<string, unknown>): string {
  return hashActionPayload({
    model: String(version.analysis_model ?? ""),
    generated: (version.generated_analysis ?? null) as never,
  });
}

function possibleIdentityMatch(
  version: Record<string, unknown>,
): PossibleSkillIdentityMatch | null {
  const identity = (
    version.deterministic_analysis as {
      identity?: { possible_match?: PossibleSkillIdentityMatch | null };
    } | null
  )?.identity;
  const match = identity?.possible_match ?? null;
  return match && match.skillId ? match : null;
}

/** Records the proposal message and the pending row for an exact payload. */
async function proposePendingAction(args: {
  tenantId: string;
  versionId: string;
  conversationId: string;
  action: PendingSkillAction;
  content: string;
  db: Db;
}) {
  const actionMessageId = await addMessage({
    conversationId: args.conversationId,
    role: "assistant",
    content: args.content,
    structuredContent: { type: "pending_action", action: args.action },
    db: args.db,
  });
  const inserted = await args.db.from("altien_skill_pending_actions").insert({
    id: args.action.id,
    tenant_id: args.tenantId,
    conversation_id: args.conversationId,
    version_id: args.versionId,
    proposed_by_message_id: actionMessageId,
    action_type: args.action.actionType,
    payload: args.action.payload,
    payload_hash: args.action.payloadHash,
    state: "pending",
  });
  throwOnDbError(inserted);
  return { conversationId: args.conversationId, outcome: "proposed", action: args.action };
}

/**
 * Applies an authorized `link_prior_skill` action: the draft becomes a version
 * of the confirmed prior skill and the placeholder skill created at import is
 * removed once it holds no versions.
 */
async function executeLinkPriorSkill(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  conversationId: string;
  userMessageId: string;
  pending: Record<string, unknown>;
  skill: Record<string, unknown>;
  version: Record<string, unknown>;
  db: Db;
}) {
  const payload = args.pending.payload as {
    currentSkillId?: string;
    priorSkillId?: string;
    contentHash?: string;
  };
  const contentHash = String(
    args.version.adapted_content_hash ??
      args.version.original_content_hash ??
      "",
  );
  if (
    String(args.skill.id) !== String(payload.currentSkillId) ||
    String(payload.contentHash) !== contentHash
  ) {
    throw new Error("The pending action no longer matches this import.");
  }
  const prior = requireResult<Record<string, unknown>>(
    await args.db
      .from("altien_skills")
      .select("id, canonical_name, display_name")
      .eq("id", String(payload.priorSkillId))
      .eq("tenant_id", args.tenantId)
      .is("deleted_at", null)
      .single(),
    "The matched prior skill is no longer available.",
  );
  const moved = await args.db
    .from("altien_skill_versions")
    .update({ skill_id: String(prior.id) })
    .eq("id", args.versionId);
  throwOnDbError(moved);
  const remaining = await args.db
    .from("altien_skill_versions")
    .select("id")
    .eq("skill_id", String(payload.currentSkillId));
  throwOnDbError(remaining);
  if (!(remaining.data ?? []).length) {
    const removed = await args.db
      .from("altien_skills")
      .delete()
      .eq("id", String(payload.currentSkillId))
      .eq("tenant_id", args.tenantId);
    throwOnDbError(removed);
  }
  await args.db
    .from("altien_skill_pending_actions")
    .update({
      state: "executed",
      authorised_by: args.userId,
      authorised_by_message_id: args.userMessageId,
      authorised_at: new Date().toISOString(),
      execution_result: {
        linkedSkillId: String(prior.id),
        replacedSkillId: String(payload.currentSkillId),
      },
    })
    .eq("id", String(args.pending.id));
  await addMessage({
    conversationId: args.conversationId,
    role: "assistant",
    content: `This draft is now a new version of '${String(prior.canonical_name)}'. It is still draft until you enable it.`,
    structuredContent: {
      type: "action_executed",
      actionId: args.pending.id,
      versionId: args.versionId,
    },
    db: args.db,
  });
  return {
    conversationId: args.conversationId,
    outcome: "linked",
    actionId: args.pending.id,
  };
}

/**
 * Read-only snapshot access for the review conversation.
 *
 * The conversation has no model tool loop — analysis is one bounded
 * completion — so rather than inventing one, list/search/read are
 * deterministic commands handled server-side before anything else. They are
 * backed by the same tenant-scoped read-only `SkillResourceStore` the runtime
 * uses, over the version's own immutable manifest, so no content crosses the
 * tenant boundary and nothing is ever written or executed.
 */
type SnapshotCommand =
  | { kind: "list" }
  | { kind: "search"; query: string }
  | { kind: "read"; path: string; offset: number };

const SNAPSHOT_READ_MAX_CHARS = 8_000;
const SNAPSHOT_SEARCH_MAX_RESULTS = 10;

export const SKILL_SNAPSHOT_COMMAND_SYNTAX =
  "list · search <text> · read <path> [@offset]";

function parseSnapshotCommand(message: string): SnapshotCommand | null {
  const trimmed = message.trim();
  if (/^list(\s+(files|snapshot))?[.!]?$/i.test(trimmed)) return { kind: "list" };
  const search = /^search\s+(.{1,200})$/i.exec(trimmed);
  if (search) {
    return {
      kind: "search",
      query: search[1].trim().replace(/^["']|["']$/g, ""),
    };
  }
  const read = /^read\s+(\S{1,400})(?:\s+@?(\d{1,7}))?$/i.exec(trimmed);
  if (read) {
    return {
      kind: "read",
      path: read[1].replace(/^["']|["']$/g, ""),
      offset: read[2] ? Number(read[2]) : 0,
    };
  }
  return null;
}

function snapshotResourceStore(
  version: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  db: Db,
) {
  const manifest = (version.adapted_manifest ?? snapshot.manifest) as
    | { files?: Array<Record<string, unknown>> }
    | undefined;
  const files = (manifest?.files ?? []).filter(
    (file) => !!file.document_version_id,
  );
  return new SkillResourceStore(
    files.map((file) => ({
      path: String(file.path),
      bytes: Number(file.bytes ?? 0),
      media_type: String(file.media_type ?? "application/octet-stream"),
      inspection_class: String(file.inspection_class ?? "binary") as
        | "text"
        | "source"
        | "binary"
        | "nested_archive",
      document_version_id: String(file.document_version_id),
      sha256: String(file.sha256 ?? ""),
    })),
    db,
  );
}

async function runSnapshotCommand(args: {
  command: SnapshotCommand;
  conversationId: string;
  version: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  db: Db;
}) {
  const store = snapshotResourceStore(args.version, args.snapshot, args.db);
  let content: string;
  let result: unknown;
  if (args.command.kind === "list") {
    const files = store.list();
    result = files;
    content = [
      `Snapshot files (${files.length}):`,
      ...files.map(
        (file) =>
          `${file.path} — ${file.bytes} bytes${file.readable ? "" : ` (inert: ${file.inert_reason})`}`,
      ),
    ].join("\n");
  } else if (args.command.kind === "search") {
    const found = await store.search({
      query: args.command.query,
      max_results: SNAPSHOT_SEARCH_MAX_RESULTS,
    });
    result = found;
    content = found.matches.length
      ? [
          `Matches for “${args.command.query}” (${found.matches.length}):`,
          ...found.matches.map(
            (match) => `${match.path} @${match.offset}: ${match.context}`,
          ),
        ].join("\n")
      : `No snapshot text matches “${args.command.query}”.`;
  } else {
    const read = await store.read({
      path: args.command.path,
      offset: args.command.offset,
      max_chars: SNAPSHOT_READ_MAX_CHARS,
    });
    result = read;
    content = `${read.path} @${read.offset}${read.truncated ? " (truncated)" : ""}:\n${read.text}`;
  }
  await addMessage({
    conversationId: args.conversationId,
    role: "assistant",
    content,
    structuredContent: { type: "snapshot_view", command: args.command, result },
    db: args.db,
  });
  return {
    conversationId: args.conversationId,
    outcome: "snapshot" as const,
    command: args.command,
    result,
  };
}

async function catalogueFor(userId: string, db: Db): Promise<ToolCatalogueItem[]> {
  return [
    ...firstPartyToolCatalogue(),
    ...(await inspectMcpToolCatalogue(userId, db)),
  ];
}

/** Expiry, version binding, and payload integrity, before any payload is used. */
async function assertPendingCurrent(
  pending: Record<string, unknown>,
  versionId: string,
  db: Db,
) {
  if (
    new Date(String(pending.expires_at)).getTime() <= Date.now() ||
    pending.version_id !== versionId
  ) {
    await db
      .from("altien_skill_pending_actions")
      .update({ state: "expired" })
      .eq("id", String(pending.id));
    throw new Error("The pending action has expired.");
  }
  assertActionIntegrity({
    payload: pending.payload as Record<string, unknown>,
    payloadHash: String(pending.payload_hash),
  });
}

/**
 * Story 15: an amendment never edits the reviewed payload in place. The
 * reviewed action is marked superseded and a NEW action is proposed whose
 * hash covers exactly the amended content, so approval keeps verifying the
 * hash of what the administrator was shown.
 */
async function amendPendingAction(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  conversationId: string;
  pending: Record<string, unknown>;
  amendments: SkillActionAmendment[];
  skill: Record<string, unknown>;
  db: Db;
}) {
  if (args.pending.action_type !== "enable_version") {
    throw new Error("Only a pending enable action can be amended.");
  }
  await assertPendingCurrent(args.pending, args.versionId, args.db);
  const rename = args.amendments.find(
    (amendment): amendment is Extract<SkillActionAmendment, { kind: "rename" }> =>
      amendment.kind === "rename",
  );
  const capabilityAmendments = args.amendments.filter(
    (amendment) => amendment.kind !== "rename",
  );
  if (rename && capabilityAmendments.length) {
    throw new Error(
      "A rename amendment resets analysis, so it must be issued on its own.",
    );
  }
  const payload = args.pending.payload as {
    analysisInputHash?: string;
    analysisOutputHash?: string;
    executionContract?: Record<string, unknown>;
  };
  let action: PendingSkillAction;
  let content: string;
  if (rename) {
    action = createRenameSkillAction({
      versionId: args.versionId,
      currentDisplayName: String(args.skill.display_name),
      newDisplayName: rename.displayName,
      amendedFromActionId: String(args.pending.id),
    });
    content = [
      `Amended pending action: rename this draft from “${String(args.skill.display_name)}” to “${rename.displayName}”.`,
      "This supersedes the pending enable action. Approving rewrites the adapted tree and resets analysis, so the version must be analysed and proposed for enablement again.",
      `Reply “yes” to authorize this payload, “no” to reject it, or amend again: ${SKILL_AMENDMENT_SYNTAX}`,
    ].join("\n");
  } else {
    const amended = applyCapabilityAmendments({
      contract: (payload.executionContract ?? {}) as Record<string, unknown>,
      amendments: capabilityAmendments,
      catalogue: await catalogueFor(args.userId, args.db),
    });
    const approved = Array.isArray(amended.contract.approvedToolNames)
      ? (amended.contract.approvedToolNames as string[])
      : [];
    action = createEnableAction({
      versionId: args.versionId,
      analysisInputHash: String(payload.analysisInputHash ?? ""),
      analysisOutputHash: String(payload.analysisOutputHash ?? ""),
      executionContract: amended.contract,
      amendedFromActionId: String(args.pending.id),
    });
    content = [
      "Amended pending action: enable this exact reviewed version with the amended capability set.",
      ...amended.effects,
      `Approved tools: ${
        approved.length
          ? approved
              .map((name) =>
                labelForTool(
                  name,
                  (payload.executionContract as { toolLabels?: Record<string, string> })
                    ?.toolLabels,
                ),
              )
              .join(", ")
          : "none"
      }.`,
      `Project read baseline: ${amended.contract.projectRead ? "on" : "off"}.`,
      `Reply “yes” to authorize this amended payload, “no” to reject it, or amend again: ${SKILL_AMENDMENT_SYNTAX}`,
    ].join("\n");
  }
  const superseded = await args.db
    .from("altien_skill_pending_actions")
    .update({ state: "superseded", superseded_by_action_id: action.id })
    .eq("id", String(args.pending.id));
  throwOnDbError(superseded);
  const proposed = await proposePendingAction({
    tenantId: args.tenantId,
    versionId: args.versionId,
    conversationId: args.conversationId,
    action,
    content,
    db: args.db,
  });
  return {
    ...proposed,
    outcome: "amended",
    supersededActionId: String(args.pending.id),
  };
}

/**
 * Applies an authorized `rename_skill` amendment through the ordinary
 * adaptation path, which resets analysis by design.
 */
async function executeRenameSkill(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  conversationId: string;
  userMessageId: string;
  pending: Record<string, unknown>;
  skill: Record<string, unknown>;
  rename: typeof persistSkillRename;
  db: Db;
}) {
  const payload = args.pending.payload as {
    versionId?: string;
    currentDisplayName?: string;
    newDisplayName?: string;
  };
  if (
    String(payload.versionId) !== args.versionId ||
    String(payload.currentDisplayName) !== String(args.skill.display_name)
  ) {
    throw new Error("The pending action no longer matches this import.");
  }
  const renamed = await args.rename({
    tenantId: args.tenantId,
    versionId: args.versionId,
    newDisplayName: String(payload.newDisplayName),
    adaptedBy: args.userId,
    db: args.db,
  });
  await args.db
    .from("altien_skill_pending_actions")
    .update({
      state: "executed",
      authorised_by: args.userId,
      authorised_by_message_id: args.userMessageId,
      authorised_at: new Date().toISOString(),
      execution_result: {
        displayName: renamed.displayName,
        canonicalName: renamed.canonicalName,
        contentHash: renamed.contentHash,
      },
    })
    .eq("id", String(args.pending.id));
  await addMessage({
    conversationId: args.conversationId,
    role: "assistant",
    content: `This draft is now “${renamed.displayName}”. Its adapted tree changed, so analysis was reset — analyse it again before proposing enablement.`,
    structuredContent: {
      type: "action_executed",
      actionId: args.pending.id,
      versionId: args.versionId,
    },
    db: args.db,
  });
  return {
    conversationId: args.conversationId,
    outcome: "renamed",
    actionId: args.pending.id,
    displayName: renamed.displayName,
  };
}

/**
 * Story 38: acquisition of a declared-but-missing dependency runs only after
 * the administrator authorizes this exact repository/ref payload, and then
 * only through the ordinary gated acquisition path — the same deployment and
 * tenant gates, OAuth token, host restriction, and DMS pipeline as a manual
 * GitHub import. The acquired snapshot lands as a draft; it is not bound as a
 * dependency and it is not enabled.
 */
async function executeAcquireDependency(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  conversationId: string;
  userMessageId: string;
  pending: Record<string, unknown>;
  acquire: typeof acquireGitHubSkill;
  storeSnapshot: typeof storeSkillSnapshot;
  githubPolicy: typeof getGitHubSkillImportPolicy;
  githubToken: typeof getGitHubSkillOAuthToken;
  db: Db;
}) {
  const payload = args.pending.payload as {
    versionId?: string;
    dependencyName?: string;
    url?: string;
  };
  if (String(payload.versionId) !== args.versionId) {
    throw new Error("The pending action no longer matches this import.");
  }
  const policy = await args.githubPolicy(args.tenantId, args.db);
  if (!policy.deploymentAllowed) {
    throw new Error("GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED");
  }
  if (!policy.tenantEnabled) {
    throw new Error("GITHUB_SKILL_IMPORT_TENANT_DISABLED");
  }
  const token = (await args.githubToken(args.tenantId, args.db)) ?? undefined;
  const acquired = await args.acquire({ url: String(payload.url), token });
  const stored = await args.storeSnapshot({
    tenantId: args.tenantId,
    importedBy: args.userId,
    sourceFilename: `${acquired.provenance.repository.replace(/[^a-z0-9.-]+/gi, "-")}-${acquired.provenance.resolvedCommitSha.slice(0, 12)}.zip`,
    sourceBytes: acquired.sourceBytes,
    snapshot: acquired.snapshot,
    sourceKind: "github",
    github: acquired.provenance,
    db: args.db,
  });
  await args.db
    .from("altien_skill_pending_actions")
    .update({
      state: "executed",
      authorised_by: args.userId,
      authorised_by_message_id: args.userMessageId,
      authorised_at: new Date().toISOString(),
      execution_result: {
        snapshotId: stored.id,
        repository: acquired.provenance.repository,
        resolvedCommitSha: acquired.provenance.resolvedCommitSha,
        draftSkillIds: (stored.skills ?? []).map((skill) => skill.id),
      },
    })
    .eq("id", String(args.pending.id));
  await addMessage({
    conversationId: args.conversationId,
    role: "assistant",
    content: `Acquired “${String(payload.dependencyName)}” from ${acquired.provenance.repository} at commit ${acquired.provenance.resolvedCommitSha.slice(0, 12)} as a draft. Review and enable it, then bind it as a dependency, before this skill can use it.`,
    structuredContent: {
      type: "action_executed",
      actionId: args.pending.id,
      snapshotId: stored.id,
    },
    db: args.db,
  });
  return {
    conversationId: args.conversationId,
    outcome: "acquired",
    actionId: args.pending.id,
    snapshotId: stored.id,
  };
}

export async function postSkillReviewMessage(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  message: string;
  db?: Db;
  acquire?: typeof acquireGitHubSkill;
  storeSnapshot?: typeof storeSkillSnapshot;
  githubPolicy?: typeof getGitHubSkillImportPolicy;
  githubToken?: typeof getGitHubSkillOAuthToken;
  rename?: typeof persistSkillRename;
  settings?: typeof getUserModelSettings;
}) {
  const db = args.db ?? createServerSupabase();
  const context = await loadSkillVersionContext({ ...args, db });
  const conversationId = await ensureConversation({ ...args, db });
  const userMessageId = await addMessage({
    conversationId,
    role: "user",
    content: args.message,
    actorUserId: args.userId,
    db,
  });
  const snapshotCommand = parseSnapshotCommand(args.message);
  if (snapshotCommand) {
    return await runSnapshotCommand({
      command: snapshotCommand,
      conversationId,
      version: context.version,
      snapshot: context.snapshot,
      db,
    });
  }
  const pendingResult = await db
    .from("altien_skill_pending_actions")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("state", "pending")
    .order("created_at", { ascending: false })
    .limit(1);
  throwOnDbError(pendingResult);
  const pending = (pendingResult.data?.[0] ?? null) as Record<
    string,
    unknown
  > | null;

  const amendments = parseSkillActionAmendments(args.message);
  if (amendments) {
    if (!pending) {
      throw new Error("There is no pending action to amend.");
    }
    return await amendPendingAction({
      tenantId: args.tenantId,
      versionId: args.versionId,
      userId: args.userId,
      conversationId,
      pending,
      amendments,
      skill: context.skill,
      db,
    });
  }

  if (pending && isRejection(args.message)) {
    await db
      .from("altien_skill_pending_actions")
      .update({ state: "rejected" })
      .eq("id", String(pending.id));
    await addMessage({
      conversationId,
      role: "assistant",
      content: "The pending action was rejected. No skill state changed.",
      db,
    });
    return { conversationId, outcome: "rejected", actionId: pending.id };
  }

  // “enable” is an affirmative for an enable action only: it must never be
  // read as authorization for an acquisition, rename, or identity link.
  const enableWord = /^enable(\s+it)?[.!]?$/i.test(args.message.trim());
  if (
    pending &&
    isAffirmativeAuthorization(args.message) &&
    !(enableWord && pending.action_type !== "enable_version")
  ) {
    await assertPendingCurrent(pending, args.versionId, db);
    if (pending.action_type === "rename_skill") {
      return await executeRenameSkill({
        tenantId: args.tenantId,
        versionId: args.versionId,
        userId: args.userId,
        conversationId,
        userMessageId,
        pending,
        skill: context.skill,
        rename: args.rename ?? persistSkillRename,
        db,
      });
    }
    if (pending.action_type === "acquire_dependency") {
      return await executeAcquireDependency({
        tenantId: args.tenantId,
        versionId: args.versionId,
        userId: args.userId,
        conversationId,
        userMessageId,
        pending,
        acquire: args.acquire ?? acquireGitHubSkill,
        storeSnapshot: args.storeSnapshot ?? storeSkillSnapshot,
        githubPolicy: args.githubPolicy ?? getGitHubSkillImportPolicy,
        githubToken: args.githubToken ?? getGitHubSkillOAuthToken,
        db,
      });
    }
    if (pending.action_type === "link_prior_skill") {
      return await executeLinkPriorSkill({
        tenantId: args.tenantId,
        versionId: args.versionId,
        userId: args.userId,
        conversationId,
        userMessageId,
        pending,
        skill: context.skill,
        version: context.version,
        db,
      });
    }
    if (
      pending.action_type !== "enable_version" ||
      context.version.analysis_state !== "succeeded" ||
      (pending.payload as Record<string, unknown>).analysisInputHash !==
        context.version.analysis_input_hash ||
      (pending.payload as Record<string, unknown>).analysisOutputHash !==
        analysisOutputHash(context.version)
    ) {
      throw new Error("The pending action no longer matches this analysis.");
    }
    const payload = pending.payload as {
      executionContract: Record<string, unknown>;
    };
    const approvedContract = {
      ...payload.executionContract,
      approvedAt: new Date().toISOString(),
      approvedBy: args.userId,
    };
    const oldCurrent = context.skill.current_version_id;
    if (oldCurrent && oldCurrent !== args.versionId) {
      await db
        .from("altien_skill_versions")
        .update({ state: "superseded" })
        .eq("id", String(oldCurrent))
        .eq("state", "enabled");
    }
    const enabled = await db
      .from("altien_skill_versions")
      .update({
        state: "enabled",
        approved_execution_contract: approvedContract,
        enabled_by: args.userId,
        enabled_at: new Date().toISOString(),
      })
      .eq("id", args.versionId);
    throwOnDbError(enabled);
    const promoted = await db
      .from("altien_skills")
      .update({
        current_version_id: args.versionId,
        updated_by: args.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(context.skill.id))
      .eq("tenant_id", args.tenantId);
    throwOnDbError(promoted);
    await db
      .from("altien_skill_pending_actions")
      .update({
        state: "executed",
        authorised_by: args.userId,
        authorised_by_message_id: userMessageId,
        authorised_at: new Date().toISOString(),
        execution_result: { enabledVersionId: args.versionId },
      })
      .eq("id", String(pending.id));
    await addMessage({
      conversationId,
      role: "assistant",
      content: "The reviewed version is enabled for new project runs.",
      structuredContent: {
        type: "action_executed",
        actionId: pending.id,
        versionId: args.versionId,
      },
      db,
    });
    return { conversationId, outcome: "enabled", actionId: pending.id };
  }

  // A weak import-identity match never attaches silently; the administrator
  // confirms it here before the version can be enabled under the prior skill.
  const possibleMatch = possibleIdentityMatch(context.version);
  if (
    possibleMatch &&
    String(context.skill.id) !== String(possibleMatch.skillId)
  ) {
    const linkActions = await db
      .from("altien_skill_pending_actions")
      .select("id, state")
      .eq("version_id", args.versionId)
      .eq("action_type", "link_prior_skill");
    throwOnDbError(linkActions);
    const outstanding = (linkActions.data ?? []).some((row) =>
      ["pending", "executed", "rejected"].includes(String(row.state)),
    );
    if (!outstanding) {
      return await proposePendingAction({
        tenantId: args.tenantId,
        versionId: args.versionId,
        conversationId,
        action: createLinkPriorSkillAction({
          versionId: args.versionId,
          currentSkillId: String(context.skill.id),
          priorSkillId: String(possibleMatch.skillId),
          priorCanonicalName: String(possibleMatch.canonicalName),
          matchedOn: String(possibleMatch.matchedOn),
          contentHash: String(
            context.version.adapted_content_hash ??
              context.version.original_content_hash ??
              "",
          ),
        }),
        content: `This import matches the existing skill '${possibleMatch.canonicalName}' only by ${possibleMatch.matchedOn === "zip_source" ? "source filename and entrypoint set" : "declared name"}. Pending action: make it a new version of that skill. Reply “yes” to authorize this payload, or “no” to keep it as a separate skill.`,
        db,
      });
    }
  }

  assertReviewable(context.version);
  if (context.version.analysis_state !== "succeeded") {
    throw new Error("Successful fast-model analysis is required first.");
  }
  const generated = context.version.generated_analysis as
    | { unresolvedReferences?: unknown[] }
    | undefined;
  const unresolvedReferences = Array.isArray(generated?.unresolvedReferences)
    ? generated.unresolvedReferences.map((value) => String(value)).filter(Boolean)
    : [];
  // A rename rewrites references deterministically and the fast model flags
  // what it could not rewrite, so promotion of an *adapted* version stays
  // blocked until those are cleared. On a first import the same list is only
  // an observation about the package; blocking on it would leave the
  // administrator no way forward, so it is reviewed as part of the payload.
  if (unresolvedReferences.length && context.version.adapted_content_hash) {
    throw new Error(
      `Unresolved references to the previous identity must be cleared before this adapted version can be enabled: ${unresolvedReferences.join("; ")}.`,
    );
  }
  // A declared `github.com` dependency URL is evidence, not an instruction:
  // nothing is fetched until the administrator authorizes the exact payload.
  const missingDependencies = await missingDeclaredGitHubDependencies({
    version: context.version,
    versionId: args.versionId,
    db,
  });
  if (missingDependencies.length) {
    const acquisitions = await db
      .from("altien_skill_pending_actions")
      .select("payload, state")
      .eq("version_id", args.versionId)
      .eq("action_type", "acquire_dependency");
    throwOnDbError(acquisitions);
    const handled = new Set(
      (acquisitions.data ?? [])
        .filter((row) =>
          ["pending", "executed", "rejected"].includes(String(row.state)),
        )
        .map((row) => String((row.payload as { url?: string })?.url ?? "")),
    );
    const next = missingDependencies.find(
      (dependency) => !handled.has(dependency.url),
    );
    if (next) {
      return await proposePendingAction({
        tenantId: args.tenantId,
        versionId: args.versionId,
        conversationId,
        action: createAcquireDependencyAction({
          versionId: args.versionId,
          dependencyName: next.name,
          url: next.url,
          owner: next.owner,
          repository: next.repository,
          ref: next.ref,
          path: next.path,
        }),
        content: [
          `This skill declares the dependency “${next.name}” at ${next.url}, and no approved version of it is bound.`,
          `Pending action: acquire exactly ${next.repository}${next.ref ? ` at ref ${next.ref}` : ""}${next.path ? `, path ${next.path}` : ""} through the gated GitHub acquisition service. Nothing is fetched until you authorize it, and the result is a draft that still needs review, enablement, and an explicit dependency binding.`,
          "Reply “yes” to authorize this payload, or “no” to leave the dependency unmet.",
        ].join("\n"),
        db,
      });
    }
  }

  const settings = await (args.settings ?? getUserModelSettings)(
    args.userId,
    db,
  );
  const skillDependencies = await dependencyBindings(
    args.versionId,
    db,
    args.tenantId,
  );
  const contract = await resolveCapabilityContractWithLlm({
    analysis: context.version.generated_analysis as never,
    catalogue: await catalogueFor(args.userId, db),
    skillDependencies,
    model: skillAnalysisModel(settings.fast_model),
    apiKeys: settings.api_keys,
  });
  if (contract.blockers.length > 0) {
    // Connector gaps lead: they are the ones an administrator can resolve
    // today by connecting the server the skill names.
    const isConnector = (name: string) => /\bmcp\b|connector/i.test(name);
    const ordered = [
      ...contract.blockers.filter((b) => isConnector(b.requirement.name)),
      ...contract.blockers.filter((b) => !isConnector(b.requirement.name)),
    ].map((blocker) => blocker.requirement.name);
    const structural = contract.mappings
      .filter((mapping) => STRUCTURAL_GAP_STATUSES.includes(mapping.status))
      .map((mapping) => mapping.requirement.name);
    throw new Error(
      [
        `Required capabilities are missing or unavailable: ${ordered.join(", ")}.`,
        ordered.some(isConnector)
          ? "Connect the named MCP server in Account → Connectors, then propose again."
          : "",
        structural.length
          ? `Not blocking — this deployment does not provide these at all: ${structural.join(", ")}. Generate a clean-room brief for them.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  const withdrawn = await toolsAnUpgradeWouldWithdraw({
    skillId: String(context.skill.id),
    versionId: args.versionId,
    approvedToolNames: contract.approvedToolNames,
    toolLabels: contract.toolLabels,
    db,
  });
  return await proposePendingAction({
    tenantId: args.tenantId,
    versionId: args.versionId,
    conversationId,
    action: createEnableAction({
      versionId: args.versionId,
      analysisInputHash: String(context.version.analysis_input_hash),
      analysisOutputHash: analysisOutputHash(context.version),
      executionContract: contract,
      unresolvedReferences,
    }),
    content: [
      "Pending action: enable this exact reviewed version for project-bound runs.",
      `Approved tools: ${
        contract.approvedToolNames.length
          ? contract.approvedToolNames
              .map((name) => labelForTool(name, contract.toolLabels))
              .join(", ")
          : "none"
      }.`,
      ...(withdrawn.length
        ? [
            `This replaces an enabled version and TAKES AWAY: ${withdrawn.join(", ")}. Approving accepts that loss — nothing in the package asks for it, so it is the analysis reading this version differently. Amend the proposal if the skill still needs them.`,
          ]
        : []),
      ...(unresolvedReferences.length
        ? [
            `The analysis could not resolve: ${unresolvedReferences.join("; ")}. These grant nothing and are part of what you are approving.`,
          ]
        : []),
      ...contract.mappings
        .filter((mapping) =>
          ["needs_admin_selection", "proposed"].includes(mapping.status),
        )
        .map((mapping) =>
          mapping.status === "needs_admin_selection"
            ? `“${mapping.requirement.name}” names no explicit capability and grants nothing until you select a minimum set.`
            : `“${mapping.requirement.name}” has the name-match candidate ${mapping.mappedToolNames.join(", ")}, which is not approved on name equality alone.`,
        ),
      `Reply “yes” to authorize this payload, “no” to reject it, or amend it: ${SKILL_AMENDMENT_SYNTAX}`,
      `You can also inspect the snapshot: ${SKILL_SNAPSHOT_COMMAND_SYNTAX}`,
    ].join("\n"),
    db,
  });
}

/**
 * Tools the currently enabled version of this skill holds that the version
 * under review would not.
 *
 * An upgrade is reviewed on its own terms, so a contract that grants less than
 * the one it replaces reads as perfectly reasonable — every row is defensible
 * in isolation. Upgrading dingduff-citation-check by one patch version dropped
 * verify_citation_sources, the anchor check its own instructions call
 * load-bearing, because one behaviour of one requirement found no match that
 * run and partial cover grants nothing. Nothing in the package changed. The
 * reviewer had no way to see it and approved the reduction.
 */
async function toolsAnUpgradeWouldWithdraw(args: {
  skillId: string;
  versionId: string;
  approvedToolNames: string[];
  toolLabels?: Record<string, string>;
  db: Db;
}): Promise<string[]> {
  const enabled = await args.db
    .from("altien_skill_versions")
    .select("id, approved_execution_contract")
    .eq("skill_id", args.skillId)
    .eq("state", "enabled");
  throwOnDbError(enabled);
  const previous = ((enabled.data ?? []) as Record<string, unknown>[]).find(
    (row) => String(row.id) !== args.versionId,
  );
  if (!previous) return [];
  const contract = previous.approved_execution_contract as {
    approvedToolNames?: unknown;
  } | null;
  const held = Array.isArray(contract?.approvedToolNames)
    ? contract.approvedToolNames.map(String)
    : [];
  const proposed = new Set(args.approvedToolNames);
  return held
    .filter((name) => !proposed.has(name))
    .map((name) => labelForTool(name, args.toolLabels));
}

export async function getSkillReview(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const context = await loadSkillVersionContext({ ...args, db });
  const conversationId = await ensureConversation({ ...args, db });
  const messages = await db
    .from("altien_skill_import_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  throwOnDbError(messages);
  const pendingActions = await db
    .from("altien_skill_pending_actions")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("state", "pending")
    .order("created_at", { ascending: false });
  throwOnDbError(pendingActions);
  return {
    conversationId,
    skill: context.skill,
    version: context.version,
    deterministicAnalysis: context.version.deterministic_analysis ?? {},
    generatedAnalysis: context.version.generated_analysis ?? {},
    dependencies: await dependencyBindings(args.versionId, db, args.tenantId),
    declaredGitHubDependencies: await missingDeclaredGitHubDependencies({
      version: context.version,
      versionId: args.versionId,
      db,
    }),
    pendingActions: pendingActions.data ?? [],
    amendmentSyntax: SKILL_AMENDMENT_SYNTAX,
    snapshotCommandSyntax: SKILL_SNAPSHOT_COMMAND_SYNTAX,
    messages: messages.data ?? [],
  };
}

export async function createSkillRun(args: {
  tenantId: string;
  versionId: string;
  projectId: string;
  userId: string;
  selectedDocumentIds?: readonly unknown[];
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const selectedDocumentIds = await resolveSelectedProjectDocuments({
    projectId: args.projectId,
    documentIds: args.selectedDocumentIds ?? [],
    db,
  });
  let context = await loadSkillVersionContext({ ...args, db });
  const pin = await getProjectSkillPin({
    tenantId: args.tenantId,
    projectId: args.projectId,
    skillId: String(context.skill.id),
    db,
  });
  const resolvedVersionId = pin?.versionId ?? args.versionId;
  if (resolvedVersionId !== args.versionId) {
    context = await loadSkillVersionContext({
      tenantId: args.tenantId,
      versionId: resolvedVersionId,
      db,
    });
  }
  if (context.version.state !== "enabled") {
    throw new Error("Only an enabled skill version can start a new run.");
  }
  const dependencies = await resolvedDependencyBindings(
    resolvedVersionId,
    db,
    args.tenantId,
  );
  const chat = requireResult<{ id: string }>(
    await db
      .from("chats")
      .insert({
        id: randomUUID(),
        user_id: args.userId,
        project_id: args.projectId,
        title: String(context.skill.display_name),
      })
      .select("id")
      .single(),
    "Failed to create skill chat.",
  );
  const binding = await db.from("altien_chat_skill_bindings").insert({
    chat_id: chat.id,
    tenant_id: args.tenantId,
    project_id: args.projectId,
    root_skill_id: context.skill.id,
    root_version_id: resolvedVersionId,
    bound_by: args.userId,
    dependency_versions: dependencies,
    selected_document_ids: selectedDocumentIds,
  });
  throwOnDbError(binding);
  return {
    chatId: chat.id,
    projectId: args.projectId,
    skill: {
      id: context.skill.id,
      name: context.skill.display_name,
      versionId: resolvedVersionId,
      contentHash:
        context.version.adapted_content_hash ??
        context.version.original_content_hash,
      pinned: !!pin,
      dependencies,
    },
  };
}
