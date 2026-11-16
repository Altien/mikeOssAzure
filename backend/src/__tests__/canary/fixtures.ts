// Multi-tenant issue 009: identical fixtures for two tenants, written straight
// to Postgres as the table owner. Both tenants share one user id and email, so
// ownership and grant checks in application code pass for tenant B's rows and
// only tenant isolation (RLS, issue 008) can keep them from tenant A.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export const FIXTURE_KEYS = [
  "project",
  "projectFolder",
  "document",
  "documentVersion",
  "documentEdit",
  "workflowAsset",
  "chat",
  "chatMessage",
  "review",
  "reviewChat",
  "workflow",
  "workflowShare",
  "workflowReference",
  "quickAction",
  "libraryFolder",
  "org",
  "orgInvitation",
  "uploadSession",
  "uploadFile",
  "connector",
  "connectorTool",
  "auditEvent",
  "skill",
  "skillSnapshot",
  "skillVersion",
  "citationRun",
  "wordDocument",
  "wordChat",
  "wordMessage",
  "wordEdit",
  // Main's routes merged after issue 009 (playbooks, organization archives).
  "playbook",
  "playbookShare",
  "playbookSource",
  "playbookImport",
  "orgArchive",
  // Dev: support reports (0200).
  "supportReport",
] as const;

export type FixtureKey = (typeof FIXTURE_KEYS)[number];

export interface TenantFixture {
  tenantId: string;
  directoryId?: string;
  userId: string;
  email: string;
  granteeEmail: string;
  /** Appears in every name/title/content written for this tenant. */
  marker: string;
  ids: Record<FixtureKey, string>;
}

export async function seedTenant(
  db: Client,
  opts: { tenantId: string; directoryId?: string; userId: string; email: string; granteeEmail: string; marker: string },
): Promise<TenantFixture> {
  const ids = Object.fromEntries(FIXTURE_KEYS.map((key) => [key, randomUUID()])) as Record<FixtureKey, string>;
  const { tenantId, userId: u, email, granteeEmail, marker: m } = opts;
  const run = (sql: string, params: unknown[]) => db.query(sql, params);

  await run("insert into tenants (tenant_id, status, display_name) values ($1, 'active', $2)", [tenantId, m]);
  if (opts.directoryId) {
    // New tenants default to app roles; this fixture explicitly exercises groups.
    await run("update tenants set enterprise_role_source = 'groups' where tenant_id = $1", [tenantId]);
    await run("insert into tenant_identity_sources(tid,tenant_id) values ($1,$2)", [opts.directoryId, tenantId]);
    await run("insert into tenant_group_policies(tenant_id,group_object_id,role) values ($1, 'canary-admins', 'TenantAdmin')", [tenantId]);
  }
  // Column defaults (005) take the tenant from the claim, as for API writes.
  await run("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ tenant_id: tenantId, sub: u })]);
  try {
    await run("insert into user_profiles (user_id, email, display_name) values ($1, $2, $3)", [u, email, m]);
    // Main's sign-in ensures a Personal organization (0119). Create it here so
    // the harness's own tenant-B requests do not change B's fingerprint.
    await run("select ensure_personal_organization($1)", [u]);
    await run("insert into organizations (id, name, created_by) values ($1, $2, $3)", [ids.org, `${m} org`, u]);
    await run("insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')", [ids.org, u]);
    await run("insert into org_invitations (id, org_id, email, invited_by) values ($1, $2, $3, $4)", [ids.orgInvitation, ids.org, granteeEmail, u]);
    await run("insert into projects (id, user_id, name) values ($1, $2, $3)", [ids.project, u, `${m} project`]);
    await run("insert into project_subfolders (id, project_id, user_id, name) values ($1, $2, $3, $4)", [ids.projectFolder, ids.project, u, `${m} folder`]);
    await run("insert into project_access_grants (project_id, email, role) values ($1, $2, 'viewer')", [ids.project, granteeEmail]);
    await run("insert into documents (id, project_id, user_id, status) values ($1, $2, $3, 'ready')", [ids.document, ids.project, u]);
    await run(
      "insert into document_versions (id, document_id, storage_path, source, version_number, filename, file_type) values ($1, $2, $3, 'upload', 1, $4, 'pdf')",
      [ids.documentVersion, ids.document, `canary/${ids.document}.pdf`, `${m} document.pdf`],
    );
    await run("update documents set current_version_id = $1 where id = $2", [ids.documentVersion, ids.document]);
    await run(
      "insert into document_edits (id, document_id, version_id, change_id, deleted_text, inserted_text) values ($1, $2, $3, 'c1', $4, $4)",
      [ids.documentEdit, ids.document, ids.documentVersion, `${m} edit`],
    );
    // Standalone chat and review: direct grants are refused on project content.
    await run("insert into chats (id, user_id, title) values ($1, $2, $3)", [ids.chat, u, `${m} chat`]);
    await run("insert into chat_messages (id, chat_id, role, content) values ($1, $2, 'user', $3)", [ids.chatMessage, ids.chat, JSON.stringify(`${m} message`)]);
    await run("insert into chat_access_grants (chat_id, email, role) values ($1, $2, 'viewer')", [ids.chat, granteeEmail]);
    const answerId = randomUUID();
    await run("insert into chat_messages (id, chat_id, role, content) values ($1, $2, 'assistant', $3)", [answerId, ids.chat, JSON.stringify(`${m} answer`)]);
    await run(
      "insert into support_reports (id, user_id, chat_id, message_id, description) values ($1, $2, $3, $4, $5)",
      [ids.supportReport, u, ids.chat, answerId, `${m} support report`],
    );
    await run(
      "insert into tabular_reviews (id, user_id, title, columns_config, document_ids) values ($1, $2, $3, '[]', $4)",
      [ids.review, u, `${m} review`, JSON.stringify([ids.document])],
    );
    await run("insert into tabular_review_chats (id, review_id, user_id, title) values ($1, $2, $3, $4)", [ids.reviewChat, ids.review, u, `${m} review chat`]);
    await run("insert into tabular_review_access_grants (tabular_review_id, email, role) values ($1, $2, 'viewer')", [ids.review, granteeEmail]);
    await run("insert into workflows (id, user_id, title, type, prompt_md) values ($1, $2, $3, 'assistant', $3)", [ids.workflow, u, `${m} workflow`]);
    await run("insert into workflow_shares (id, workflow_id, shared_by_user_id, shared_with_email, role) values ($1, $2, $3, $4, 'viewer')", [ids.workflowShare, ids.workflow, u, granteeEmail]);
    await run(
      "insert into workflow_reference_documents (id, workflow_id, user_id, filename, file_type, storage_path, content_hash) values ($1, $2, $3, $4, 'pdf', $5, 'h')",
      [ids.workflowReference, ids.workflow, u, `${m} reference.pdf`, `canary/${ids.workflowReference}.pdf`],
    );
    await run("insert into documents (id, user_id, status, library_kind, workflow_id) values ($1, $2, 'ready', 'workflow_asset', $3)", [ids.workflowAsset, u, ids.workflow]);
    await run("insert into quick_actions (id, user_id, workflow_id, name) values ($1, $2, $3, $4)", [ids.quickAction, u, ids.workflow, `${m} quick action`]);
    await run("insert into library_folders (id, user_id, library_kind, name) values ($1, $2, 'file', $3)", [ids.libraryFolder, u, `${m} library folder`]);
    await run(
      // The seeding role bypasses RLS and both tenants share the user id, so
      // the tenant filter is what keeps this to this tenant's memory row.
      "update memory_files set content = $1 where scope = 'user' and user_id = $2 and tenant_id = $3",
      [`${m} memory`, u, tenantId],
    );
    await run(
      `insert into upload_sessions (id, user_id, purpose, destination, expected_file_count, expected_total_bytes, expires_at)
       values ($1, $2, 'document_create', $3, 1, 10, now() + interval '1 day')`,
      [ids.uploadSession, u, JSON.stringify({ project_id: ids.project })],
    );
    await run(
      `insert into upload_session_files (id, session_id, resource_id, client_id, filename, file_type, content_type, expected_size_bytes, staging_storage_path, sealed_storage_path)
       values ($1, $2, $3, 'c1', $4, 'pdf', 'application/pdf', 10, $5, $6)`,
      [ids.uploadFile, ids.uploadSession, randomUUID(), `${m} upload.pdf`, `staging/${ids.uploadFile}`, `sealed/${ids.uploadFile}`],
    );
    await run("insert into user_mcp_connectors (id, user_id, name, server_url) values ($1, $2, $3, 'https://mcp.example.test/')", [ids.connector, u, `${m} connector`]);
    await run(
      "insert into user_mcp_connector_tools (id, connector_id, tool_name, openai_tool_name, title) values ($1, $2, 'search', $3, $4)",
      [ids.connectorTool, ids.connector, `mcp_${ids.connectorTool.slice(0, 8)}`, `${m} tool`],
    );
    await run("insert into audit_events (id, user_id, user_email, action, title, project_id) values ($1, $2, $3, 'canary', $4, $5)", [ids.auditEvent, u, email, `${m} audit`, ids.project]);
    // The Altien Skills tables carried tenant_id before 005, with no default.
    await run(
      "insert into altien_skills (id, tenant_id, canonical_name, display_name, description, created_by, updated_by) values ($1, $2, $3, $4, $4, $5, $5)",
      [ids.skill, tenantId, `canary-${ids.skill.slice(0, 8)}`, `${m} skill`, u],
    );
    await run(
      `insert into altien_skill_import_snapshots (id, tenant_id, imported_by, source_kind, dms_project_id, root_folder_id, manifest, tree_hash, expanded_bytes, file_count)
       values ($1, $2, $3, 'zip', $4, $5, '{}', 'h', 1, 1)`,
      [ids.skillSnapshot, tenantId, u, ids.project, ids.projectFolder],
    );
    await run(
      "insert into altien_skill_versions (id, tenant_id, skill_id, snapshot_id, entrypoint_path, declared_name, original_content_hash) values ($1, $2, $3, $4, 'SKILL.md', $5, 'h')",
      [ids.skillVersion, tenantId, ids.skill, ids.skillSnapshot, `${m} skill version`],
    );
    await run("update altien_skills set current_version_id = $1 where id = $2", [ids.skillVersion, ids.skill]);
    await run(
      "insert into citation_verification_runs (id, project_id, user_id, memo_document_id, memo_version_id, verified_record, report) values ($1, $2, $3, $4, $5, '{}', $6)",
      [ids.citationRun, ids.project, u, ids.document, ids.documentVersion, JSON.stringify({ title: `${m} report` })],
    );
    await run("insert into word_documents (id, user_id, client_document_id) values ($1, $2, $3)", [ids.wordDocument, u, randomUUID()]);
    await run("insert into word_chats (id, word_document_id, user_id, title) values ($1, $2, $3, $4)", [ids.wordChat, ids.wordDocument, u, `${m} word chat`]);
    await run("insert into word_chat_messages (id, chat_id, role, content) values ($1, $2, 'assistant', $3)", [ids.wordMessage, ids.wordChat, JSON.stringify(`${m} word message`)]);
    await run(
      "insert into word_document_edits (id, word_chat_message_id, block_index, original_text, replacement_text, apply_mode) values ($1, $2, 0, $3, $3, 'approval')",
      [ids.wordEdit, ids.wordMessage, `${m} word edit`],
    );
    await run(
      "insert into playbooks (id, user_id, name, content_json) values ($1, $2, $3, $4)",
      [ids.playbook, u, `${m} playbook`, JSON.stringify({ rules: [] })],
    );
    await run(
      "insert into playbook_shares (id, playbook_id, shared_by_user_id, shared_with_email, role) values ($1, $2, $3, $4, 'viewer')",
      [ids.playbookShare, ids.playbook, u, granteeEmail],
    );
    await run(
      "insert into playbook_sources (id, playbook_id, filename, file_type, storage_key, size_bytes, created_by) values ($1, $2, $3, 'pdf', $4, 10, $5)",
      [ids.playbookSource, ids.playbook, `${m} playbook source.pdf`, `canary/${ids.playbookSource}.pdf`, u],
    );
    await run(
      "insert into playbook_imports (id, user_id, filename, model, status, stage, started_at) values ($1, $2, $3, 'canary-model', 'completed', 'done', now())",
      [ids.playbookImport, u, `${m} playbook import.docx`],
    );
    await run(
      "insert into org_departure_archives (id, org_id, kind, item_id, title, expires_at) values ($1, $2, 'project', $3, $4, now() + interval '30 days')",
      [ids.orgArchive, ids.org, ids.project, `${m} archive`],
    );
  } finally {
    await run("select set_config('request.jwt.claims', '', false)", []);
  }
  return { ...opts, ids };
}

/** Tables with a `tenant_id` column, for the before/after fingerprint and cleanup. */
export async function tenantTables(db: Client): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
      order by 1`,
  );
  return rows.map((row) => row.table_name);
}

/** One digest per table over a tenant's rows; any write to them changes it. */
export async function tenantFingerprint(db: Client, tables: string[], tenantId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const { rows } = await db.query<{ digest: string | null }>(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public.${quoteIdent(table)} t where tenant_id = $1`,
      [tenantId],
    );
    out[table] = rows[0]?.digest ?? "";
  }
  return out;
}

/** Removes everything the two tenants own and restores the install tenancy row. */
export async function readInstallFallback(db: Client): Promise<string | null> {
  const { rows } = await db.query<{ fallback_tenant_id: string | null }>("select fallback_tenant_id from app.install_tenancy");
  return rows[0]?.fallback_tenant_id ?? null;
}

export async function removeTenants(db: Client, tables: string[], tenantIds: string[], fallbackTenantId: string | null): Promise<void> {
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    for (const table of tables) {
      if (table === "tenants") continue;
      await db.query(`delete from public.${quoteIdent(table)} where tenant_id = any($1)`, [tenantIds]);
    }
    await db.query("delete from tenants where tenant_id = any($1)", [tenantIds]);
    await db.query("update app.install_tenancy set fallback_tenant_id = $1", [fallbackTenantId]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
