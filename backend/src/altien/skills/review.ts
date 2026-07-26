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
  isAffirmativeAuthorization,
  isRejection,
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

type Db = ReturnType<typeof createServerSupabase>;

function errorMessage(result: { error?: { message?: string } | null }) {
  return result.error?.message ?? null;
}

function requireResult<T>(
  result: { data?: T | null; error?: { message?: string } | null },
  fallback: string,
): T {
  const message = errorMessage(result);
  if (message || !result.data) throw new Error(message ?? fallback);
  return result.data;
}

async function loadVersionContext(args: {
  tenantId: string;
  versionId: string;
  db: Db;
}) {
  const version = requireResult<Record<string, unknown>>(
    await args.db
      .from("altien_skill_versions")
      .select("*")
      .eq("id", args.versionId)
      .single(),
    "Skill version not found.",
  );
  const skill = requireResult<Record<string, unknown>>(
    await args.db
      .from("altien_skills")
      .select("*")
      .eq("id", String(version.skill_id))
      .eq("tenant_id", args.tenantId)
      .is("deleted_at", null)
      .single(),
    "Skill version not found.",
  );
  const snapshot = requireResult<Record<string, unknown>>(
    await args.db
      .from("altien_skill_import_snapshots")
      .select("*")
      .eq("id", String(version.snapshot_id))
      .eq("tenant_id", args.tenantId)
      .single(),
    "Skill snapshot not found.",
  );
  return { version, skill, snapshot };
}

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
  if (existing.error) throw new Error(existing.error.message);
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
  if (result.error) throw new Error(result.error.message);
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
  const context = await loadVersionContext({ ...args, db });
  const running = await db
    .from("altien_skill_versions")
    .update({ analysis_state: "running" })
    .eq("id", args.versionId);
  if (running.error) throw new Error(running.error.message);
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
    if (saved.error) throw new Error(saved.error.message);
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

export async function postSkillReviewMessage(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  message: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const context = await loadVersionContext({ ...args, db });
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
  if (pendingResult.error) throw new Error(pendingResult.error.message);
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
    if (enabled.error) throw new Error(enabled.error.message);
    const promoted = await db
      .from("altien_skills")
      .update({
        current_version_id: args.versionId,
        updated_by: args.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(context.skill.id))
      .eq("tenant_id", args.tenantId);
    if (promoted.error) throw new Error(promoted.error.message);
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
  const action = createEnableAction({
    versionId: args.versionId,
    analysisInputHash: String(context.version.analysis_input_hash),
    executionContract: contract,
  });
  const actionMessageId = await addMessage({
    conversationId,
    role: "assistant",
    content:
      "Pending action: enable this exact reviewed version for project-bound runs. Reply “yes” to authorize this payload.",
    structuredContent: { type: "pending_action", action },
    db,
  });
  const inserted = await db.from("altien_skill_pending_actions").insert({
    id: action.id,
    tenant_id: args.tenantId,
    conversation_id: conversationId,
    version_id: args.versionId,
    proposed_by_message_id: actionMessageId,
    action_type: action.actionType,
    payload: action.payload,
    payload_hash: action.payloadHash,
    state: "pending",
  });
  if (inserted.error) throw new Error(inserted.error.message);
  return { conversationId, outcome: "proposed", action };
}

export async function getSkillReview(args: {
  tenantId: string;
  versionId: string;
  userId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const context = await loadVersionContext({ ...args, db });
  const conversationId = await ensureConversation({ ...args, db });
  const messages = await db
    .from("altien_skill_import_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (messages.error) throw new Error(messages.error.message);
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
  let context = await loadVersionContext({ ...args, db });
  const pin = await getProjectSkillPin({
    tenantId: args.tenantId,
    projectId: args.projectId,
    skillId: String(context.skill.id),
    db,
  });
  const resolvedVersionId = pin?.versionId ?? args.versionId;
  if (resolvedVersionId !== args.versionId) {
    context = await loadVersionContext({
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
  if (binding.error) throw new Error(binding.error.message);
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
