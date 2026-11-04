// Refuses an upgrade before migration 0176 can assign existing data to the wrong
// tenant. 0176 chooses the install tenant once and stamps every existing row with
// it. If that choice differs from the configured tenant, the data belongs to a
// tenant nobody signs in as, and re-running migrations cannot change it.
//
// Runs under the migration lock, before the first pending file, so a refusal
// leaves the database exactly as it was. Shipped SQL stays unedited: this module
// repeats 0176's choice instead, and installTenantGate.test.ts pins the table list
// against the file.
import type { ClientBase } from "pg";
import { readStampConfiguration, type StampConfiguration } from "../lib/stampConfiguration";

export const TENANCY_MIGRATION = "0176_tenant_id_columns";

/** The v_tables list from 0176, in order. */
export const TENANCY_MIGRATION_TABLES = [
  "user_profiles", "user_api_keys", "user_router_models",
  "user_mcp_connectors", "user_mcp_oauth_states", "user_mcp_tool_audit_logs",
  "user_google_drive_tokens", "user_google_workspace_tokens",
  "google_drive_oauth_states", "google_workspace_oauth_states",
  "google_workspace_actions", "projects", "project_subfolders", "documents",
  "library_folders", "chats", "tabular_reviews", "tabular_review_chats",
  "word_chats", "word_documents", "workflows", "workflow_reference_documents",
  "quick_actions", "hidden_workflows", "default_workflow_installations",
  "citation_verification_runs", "citation_verification_extractions",
  "citation_verification_reviews", "external_source_cache", "memory_files",
  "memory_consolidation_states", "memory_conversation_activity",
  "audit_events", "workflow_open_source_submissions",
  "account_erasure_requests", "account_erasure_storage_paths",
  "upload_sessions",
  "organizations", "org_members", "org_invitations", "project_access_grants",
  "chat_access_grants", "tabular_review_access_grants",
  "project_org_access_overrides", "workflow_org_access_overrides",
  "workflow_shares", "tabular_review_legacy_shares",
  "chat_messages", "document_versions", "document_edits", "tabular_cells",
  "tabular_review_rows", "tabular_review_row_sources",
  "tabular_review_chat_messages", "word_chat_messages", "word_document_edits",
  "upload_session_files", "upload_session_parts", "user_mcp_connector_tools",
  "user_mcp_oauth_tokens", "memory_consolidation_results",
  "altien_skill_versions", "altien_skill_dependencies",
  "altien_skill_import_messages",
  "auth_sessions", "auth_handoff_tickets",
  "db_jobs", "upload_processing_jobs", "stream_runs", "stream_run_tool_calls",
  "memory_conversation_turn_leases",
  "org_api_keys", "org_router_models", "org_logos", "org_departure_archives",
  "org_departure_events", "org_private_content_access",
  "user_courtlistener_connections", "document_version_texts",
  "playbooks", "playbook_sources", "playbook_shares",
  "playbook_org_access_overrides", "playbook_runs", "playbook_imports",
  "chat_subagent_runs",
] as const;

export interface InstallTenantSnapshot {
  /** app.install_tenancy.fallback_tenant_id, when that table already exists. */
  recorded: string | null;
  pooled: boolean;
  /** The row 0176 would take from public.tenants. */
  firstTenant: string | null;
  hasData: boolean;
}

export interface InstallTenantPrediction {
  tenant: string;
  reason: "already-recorded" | "tenants-row" | "data-without-tenant";
}

/** 0176's choice. Null means it records nothing and the first tenant is adopted later. */
export function predictInstallTenant(snapshot: InstallTenantSnapshot): InstallTenantPrediction | null {
  if (snapshot.recorded) return { tenant: snapshot.recorded, reason: "already-recorded" };
  if (snapshot.pooled) return null;
  if (snapshot.firstTenant) return { tenant: snapshot.firstTenant, reason: "tenants-row" };
  if (snapshot.hasData) return { tenant: "default", reason: "data-without-tenant" };
  return null;
}

const PICK_REASON: Record<InstallTenantPrediction["reason"], string> = {
  "already-recorded": "the value already recorded in app.install_tenancy",
  "tenants-row": "the oldest active row in public.tenants",
  "data-without-tenant": "data exists and public.tenants is empty",
};

export type InstallTenantDecision = { action: "proceed" } | { action: "refuse"; message: string };

export function decideInstallTenantGate(input: {
  prediction: InstallTenantPrediction;
  mode: StampConfiguration["mode"];
  provider: string;
  configured: string | null;
}): InstallTenantDecision {
  const { prediction, mode, provider, configured } = input;
  if (mode !== "single") return { action: "proceed" };
  if (configured === prediction.tenant) return { action: "proceed" };
  const setting = provider === "entra" ? "entra-tenant-id" : "default-tenant-id";
  const reason = PICK_REASON[prediction.reason];
  const configuredLabel = configured ?? "(not set)";
  return {
    action: "refuse",
    message:
      `Install tenant check failed. No migration has run in this attempt and the database is unchanged. ` +
      `Migration ${TENANCY_MIGRATION} would assign all existing data to tenant "${prediction.tenant}" (${reason}), ` +
      `but this deployment is configured for tenant "${configuredLabel}" (${setting}). ` +
      `That assignment cannot be undone by re-running migrations. Decide which value is correct, change the other, ` +
      `then run the upgrade again. See "Install tenant check" in docs/upgrade-marketplace.md.`,
  };
}

type GateClient = Pick<ClientBase, "query">;
type GateConfiguration = Pick<StampConfiguration, "mode" | "provider" | "fallbackTenantId">;

async function readInstallTenantSnapshot(client: GateClient): Promise<InstallTenantSnapshot> {
  const snapshot: InstallTenantSnapshot = { recorded: null, pooled: false, firstTenant: null, hasData: false };
  const metadata = await client.query<{ present: boolean }>(
    "select to_regclass('app.install_tenancy') is not null as present",
  );
  if (metadata.rows[0]?.present) {
    const row = await client.query<{ fallback_tenant_id: string | null; pooled: boolean }>(
      "select fallback_tenant_id, pooled from app.install_tenancy",
    );
    snapshot.recorded = row.rows[0]?.fallback_tenant_id ?? null;
    snapshot.pooled = row.rows[0]?.pooled ?? false;
  }
  const tenants = await client.query<{ present: boolean }>(
    "select to_regclass('public.tenants') is not null as present",
  );
  if (tenants.rows[0]?.present) {
    const first = await client.query<{ tenant_id: string }>(
      "select tenant_id from public.tenants order by (status = 'active') desc, created_at, tenant_id limit 1",
    );
    snapshot.firstTenant = first.rows[0]?.tenant_id ?? null;
  }
  // 0176 looks for data only when it found no tenants row.
  if (snapshot.firstTenant) return snapshot;
  for (const table of TENANCY_MIGRATION_TABLES) {
    const exists = await client.query<{ present: boolean }>(
      "select to_regclass($1) is not null as present",
      [`public.${table}`],
    );
    if (!exists.rows[0]?.present) continue;
    // The name comes from the constant list above, never from input.
    const data = await client.query<{ has_data: boolean }>(`select exists (select 1 from public."${table}") as has_data`);
    if (data.rows[0]?.has_data) {
      snapshot.hasData = true;
      break;
    }
  }
  return snapshot;
}

/**
 * Throws before anything is applied if pending 0176 would choose a tenant other
 * than the configured one. A fresh database needs no configuration at this point.
 */
export async function assertInstallTenantGate(
  client: GateClient,
  pendingMigrations: readonly string[],
  readConfiguration: () => Promise<GateConfiguration> = readStampConfiguration,
): Promise<void> {
  if (!pendingMigrations.includes(TENANCY_MIGRATION)) return;
  const prediction = predictInstallTenant(await readInstallTenantSnapshot(client));
  if (!prediction) return;
  const configuration = await readConfiguration();
  const decision = decideInstallTenantGate({
    prediction,
    mode: configuration.mode,
    provider: configuration.provider,
    configured: configuration.fallbackTenantId,
  });
  if (decision.action === "refuse") throw new Error(decision.message);
}
