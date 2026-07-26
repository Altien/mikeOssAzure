import { randomUUID } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { getUserModelSettings } from "../../lib/userSettings";
import {
  analyseSkillInstructions,
  type SkillAnalysisArtifact,
} from "./analysis";
import {
  assertActionIntegrity,
  createEnableAction,
  createLinkPriorSkillAction,
  isAffirmativeAuthorization,
  isRejection,
  type PendingSkillAction,
} from "./actions";
import {
  firstPartyToolCatalogue,
  inspectMcpToolCatalogue,
  resolveCapabilityContractWithLlm,
} from "./capabilities";
import {
  dependencyBindings,
  resolvedDependencyBindings,
} from "./dependencies";
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
      model: settings.fast_model,
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
    await addMessage({
      conversationId,
      role: "assistant",
      content:
        "Analysis complete. Review the exact requirements, then tell me to enable this version if they are acceptable.",
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

export async function postSkillReviewMessage(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  message: string;
  db?: Db;
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

  if (pending && isAffirmativeAuthorization(args.message)) {
    if (
      new Date(String(pending.expires_at)).getTime() <= Date.now() ||
      pending.version_id !== args.versionId
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
        context.version.analysis_input_hash
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

  if (context.version.analysis_state !== "succeeded") {
    throw new Error("Successful fast-model analysis is required first.");
  }
  const generated = context.version.generated_analysis as
    | { unresolvedReferences?: unknown[] }
    | undefined;
  if (
    Array.isArray(generated?.unresolvedReferences) &&
    generated.unresolvedReferences.length > 0
  ) {
    throw new Error(
      "Unresolved identity references must be reviewed before enablement.",
    );
  }
  const settings = await getUserModelSettings(args.userId, db);
  const skillDependencies = await dependencyBindings(args.versionId, db);
  const contract = await resolveCapabilityContractWithLlm({
    analysis: context.version.generated_analysis as never,
    catalogue: [
      ...firstPartyToolCatalogue(),
      ...(await inspectMcpToolCatalogue(args.userId, db)),
    ],
    skillDependencies,
    model: settings.fast_model,
    apiKeys: settings.api_keys,
  });
  if (contract.blockers.length > 0) {
    throw new Error(
      `Required capabilities are missing or unavailable: ${contract.blockers
        .map((blocker) => blocker.requirement.name)
        .join(", ")}.`,
    );
  }
  return await proposePendingAction({
    tenantId: args.tenantId,
    versionId: args.versionId,
    conversationId,
    action: createEnableAction({
      versionId: args.versionId,
      analysisInputHash: String(context.version.analysis_input_hash),
      executionContract: contract,
    }),
    content:
      "Pending action: enable this exact reviewed version for project-bound runs. Reply “yes” to authorize this payload.",
    db,
  });
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
  return {
    conversationId,
    skill: context.skill,
    version: context.version,
    deterministicAnalysis: context.version.deterministic_analysis ?? {},
    generatedAnalysis: context.version.generated_analysis ?? {},
    dependencies: await dependencyBindings(args.versionId, db),
    messages: messages.data ?? [],
  };
}

export async function createSkillRun(args: {
  tenantId: string;
  versionId: string;
  projectId: string;
  userId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
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
  const dependencies = await resolvedDependencyBindings(resolvedVersionId, db);
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
