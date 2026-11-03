# 002 — Codebase readiness for pooled multi-tenancy

**Status:** Research (evidence snapshot of `main` at `795f5cac`, 2026-10-27)

This note records what the current code does that decides the cost and risk
of serving many customer organisations ("tenants") from one shared set of
Azure resources. Every claim cites `path:line` so it can be re-checked after
upstream syncs. Proposals live in [003](003-target-architecture.md).

## Summary

- **Tenant isolation does not exist in the data layer today.** Every database
  request runs as `service_role`, which has `BYPASSRLS`, and no table has RLS
  enabled. Isolation between *users* is hand-written TypeScript: 184
  `.eq("user_id", …)` filters, 130 calls to the `lib/access.ts` helpers, and
  ~60 `security definer` RPCs.
- **Sharing is keyed by email with no tenant boundary.** Any user can grant
  access to, or invite into an org, any email address on the platform.
- **Only the Altien Skills tables already carry `tenant_id`** (12 of 92
  tables), keyed by the Entra `tid`.
- **Storage, config, credentials, the model registry, the job queue and the
  Entra validator are all process-wide singletons** for one install.
- **LLM calls have two clean choke points** for token metering, but usage
  fields are never read today.

## 1. Database access layer

| Fact | Evidence |
|---|---|
| `createServerSupabase()` is supabase-js over HTTP to PostgREST, one cached admin client per process | `backend/src/lib/supabase.ts:13,85-132` |
| In Entra mode the fetch wrapper strips `Authorization`/`apikey`; PostgREST's anon role is `service_role` | `supabase.ts:49-59,110-117`; `infra/modules/containerapp-postgrest.bicep:100,108` |
| Trust between backend and PostgREST is network-only (internal ingress) | `containerapp-postgrest.bicep:96-99,131` |
| `service_role` is `nologin bypassrls` | `backend/migrations/0005_postgres_roles.sql:28` |
| `authenticated` has full CRUD on all tables incl. future ones | `0005_postgres_roles.sql:50,60` |
| No migration enables RLS; nothing reads `current_setting` | grep: RLS only in comments (`0006:25`, `0010:27`, `0039:227`) |
| PostgREST connects on 5432 in session mode, not via PgBouncer | `containerapp-postgrest.bicep:103-105` |
| Raw `pg` exists only for stream runs (pool max 4, `SET ROLE service_role`, real transactions) and migrations | `backend/src/lib/streamRunCluster.ts:81-82,132,289-303`; `backend/src/scripts/runMigrations.ts:67` |
| 87 `.rpc(` call sites, ~60 distinct functions; ~102 SQL functions, ~93 `security definer` | e.g. `get_projects_overview` ×12, `claim_db_jobs`, `create_document_version` |

**Consequence.** Per-transaction `SET LOCAL app.tenant_id` is not reachable
through the current layer: each PostgREST HTTP request is its own transaction
and the app has no session handle. The realistic hooks are PostgREST's
`db-pre-request` function (reads a request header or JWT claim and calls
`set_config`) plus a non-`BYPASSRLS` role, or an explicit `p_tenant_id`
parameter on every RPC. Both are discussed in 003.

## 2. Table inventory (92 tables)

| Class | Count | Tables |
|---|---:|---|
| Already has `tenant_id` | 12 | `tenants`, `tenant_group_policies`, `altien_skills`, `altien_skill_import_snapshots`, `altien_skill_tenant_settings`, `altien_skill_developer_artifacts`, `altien_skill_github_connections`, `altien_skill_github_oauth_states`, `altien_skill_import_conversations`, `altien_skill_pending_actions`, `altien_chat_skill_bindings`, `altien_project_skill_pins` |
| User-owned (`user_id`/owner/actor column) | 37 | `user_profiles`, `user_api_keys`, `user_router_models`, `user_mcp_connectors`, `user_mcp_oauth_states`, `user_mcp_tool_audit_logs`, `user_google_drive_tokens`, `user_google_workspace_tokens`, `google_drive_oauth_states`, `google_workspace_oauth_states`, `google_workspace_actions`, `projects`, `project_subfolders`, `documents`, `library_folders`, `chats`, `tabular_reviews`, `tabular_review_chats`, `word_chats`, `word_documents`, `workflows`, `workflow_reference_documents`, `quick_actions`, `hidden_workflows`, `default_workflow_installations`, `citation_verification_runs`/`_extractions`/`_reviews`, `external_source_cache`, `memory_files`, `memory_consolidation_states`, `memory_conversation_activity`, `audit_events`, `workflow_open_source_submissions`, `account_erasure_requests`, `account_erasure_storage_paths`, `upload_sessions` |
| Sharing / org | 11 | `organizations`, `org_members`, `org_invitations`, `project_access_grants`, `chat_access_grants`, `tabular_review_access_grants`, `project_org_access_overrides`, `workflow_org_access_overrides`, `workflow_shares`, `tabular_review_legacy_shares`, `organization_backfill_markers` |
| Child rows, no owner column (scoped only via FK) | 17 | `chat_messages`, `document_versions`, `document_edits`, `tabular_cells`, `tabular_review_rows`, `tabular_review_row_sources`, `tabular_review_chat_messages`, `word_chat_messages`, `word_document_edits`, `upload_session_files`, `upload_session_parts`, `user_mcp_connector_tools`, `user_mcp_oauth_tokens`, `memory_consolidation_results`, `altien_skill_versions`, `altien_skill_dependencies`, `altien_skill_import_messages` |
| Global catalog | 6 | `courtlistener_citation_index`, `courtlistener_opinion_cluster_index`, `mike_workflows`, `mike_workflow_assets`, `workflow_addons`, `workflow_addon_reference_files` |
| Auth / session | 3 | `auth_sessions`, `auth_handoff_tickets`, `auth_oauth_states` |
| Job / runtime | 6 | `db_jobs`, `upload_processing_jobs`, `stream_runs`, `stream_run_nodes`, `stream_run_tool_calls`, `memory_conversation_turn_leases` |

So roughly **80 tables need a `tenant_id`**; the 6 catalog tables stay global
(read-only to tenants), and the 17 child tables should get a denormalised
`tenant_id` rather than RLS policies that join through parents.

Constraints and lookups that become wrong once tenants share a database:

- `user_mcp_connector_tools unique(openai_tool_name)` — globally unique (`0010:94`).
- `projects(provenance_key)` unique for provenance/skill-library projects (`0026:22`, `0027:19`).
- `db_jobs` dedupe key (`0074:67`) and `stream_runs.run_key` (`0097:31`).
- `user_profiles.user_id` is `uuid` while 59 other `user_id` columns are `text` (`0083:29`).
- Email index is not unique (`0002:16`) but `findProfileUserByEmail` uses
  `.maybeSingle()` (`backend/src/lib/userLookup.ts:56-60`): the same email in
  two tenants makes that lookup error.

## 3. How user isolation works today

- `userId` is the Entra `oid` (`backend/src/lib/auth/providers/entra.ts:195`);
  email is lower-cased (`entra.ts:238`) and is itself an authorization input,
  because grants match by email (`backend/src/lib/auth/types.ts:36-48`).
- `principal.tenantId` (the token `tid`) is used only by `tenantAccess` and
  the Skills router (`backend/src/altien/skills/router.ts:91-102`).
- Pattern: fetch the row by id with the service role, then decide in
  TypeScript (`backend/src/lib/access.ts:177,331,401,505,528`). Example:
  chat delete is by id only after an access check
  (`backend/src/modules/chat/chat.crud.ts:105`); list views go through
  `get_*_overview(p_user_id, p_user_email)` RPCs.
- `loadProfileUsersByEmail` reads the whole `user_profiles` table
  (`userLookup.ts:28-33`), called from `projects.crud.ts:659` and
  `tabular.reviews.ts:760`.

## 4. Storage

- One provider singleton, built once at module load
  (`backend/src/lib/storage.ts:449-461`), from fixed env
  `AZURE_STORAGE_ACCOUNT_NAME` + container `documents`
  (`storage.ts:276-296`; `infra/modules/containerapp-backend.bicep:124-125`).
- Blob keys: `documents/{userId}/{docId}/…`, `generated/{userId}/…`,
  `workflow-references/{userId}/…`, `extracted-text/{versionId}.txt` (no user
  prefix), `upload-sessions/{userId}/…` (`storage.ts:623-674`;
  `backend/src/modules/uploads/uploads.manifest.ts:228-239`). Keys are stored
  in the DB (`document_versions.storage_path`).
- No SAS on Azure: downloads are proxied through the backend with an HMAC
  token (`backend/src/lib/downloadTokens.ts:111-145`). The token is
  `{p: path, f: filename}` — **no expiry, not bound to a user or tenant**,
  signed with one install-wide secret.
- 42 files / 89 call sites use storage. The account is private-endpoint only
  (`infra/modules/storage.bicep:35-38,90`), so every extra account needs its
  own private endpoint and DNS record.

## 5. Workers, jobs and process-wide state

- 10 job kinds (`backend/src/jobs/registry.ts:11-22`). Payloads carry
  `userId` at best, never a tenant (`backend/src/lib/queue/conversionQueue.ts:18`;
  `documentOps.ts:1633` carries only `{versionId, storagePath, fileType}`;
  `storage.cleanup` carries `{keys, prefixes}` — `backend/src/lib/dbq/enqueue.ts:158-160`).
- One global FIFO claim (`backend/src/lib/dbq/runner.ts:326`): no per-tenant
  fairness.
- Module-level state that is implicitly "the install": DB client
  (`supabase.ts:13`), storage (`storage.ts:449`), Key Vault config cache
  (`backend/src/lib/config.ts:34-36`), model registry from
  `MIKE_MODEL_CONFIG_JSON` (`backend/src/lib/llm/registry.ts:23`), single-tenant
  JWKS cache (`entra.ts:61`), /install session/group maps
  (`backend/src/lib/install/sessionTokens.ts:22`, `userGroups.ts:31,63`),
  in-memory rate limiters (`backend/src/app.ts:87-140`), Sentry install tag
  (`backend/src/lib/observability/sentry.ts:514`).

## 6. Shared content (workflows, templates, skills)

- `mike_workflows` is a global catalog synced from GitHub
  (`backend/src/lib/workflowCatalogSync.ts:84`); `install_missing_default_workflows`
  copies entries into per-user `workflows`/`quick_actions` rows (`0065:251-345`).
- Preset templates are a static frontend bundle; adding one makes a personal
  copy (`docs/preset-templates.md:28-38`).
- Skills are already scoped by `tid`; the skill library owner is the synthetic
  user `system:skill-library:<hash(tid)>` (`backend/src/altien/skills/artifacts.ts:35-40`).
- External-source provenance projects are shared install-wide under
  `system:external-provenance` (`backend/src/altien/externalSources/cache.ts:69`).
- Orgs (`backend/src/lib/orgs.ts`) have no tenant concept: any user can create
  an org (`orgs.ts:156`) and invite any email (`orgs.ts:632`).

## 7. LLM layer

- Provider clients: `createProviderAdapter` (`backend/src/lib/llm/providers.ts:92-356`).
- Credentials: org-wide keys from Key Vault/env (`backend/src/lib/envSecrets.ts:44-70`);
  per-user BYO keys in `user_api_keys`.
- Usage is never read. Choke points for metering: `streamWithProvider` /
  `completeWithProvider` (`providers.ts:363,430`), which wrap
  `streamAiSdk` (`backend/src/lib/llm/aiSdk.ts:408,465`; usage arrives on
  `finish-step` at `:549`) and `completeAiSdkText` (`aiSdk.ts:608-637`). All 7
  calling files enter via `backend/src/lib/llm/index.ts:7-21`.
  `StreamChatParams` carries only `apiKeys` today — it needs `userId`/`tenantId`.

## 8. Config that would become per-tenant

`getConfig()` reads env, then Key Vault, with a 5-minute cache
(`backend/src/lib/config.ts:52-82`).

| Group | Keys |
|---|---|
| Identity | `auth-provider`, `entra-tenant-id`, `entra-client-id`, `entra-backend-client-id`, `entra-client-secret`, `entra-admin-group-ids`, `entra-member-group-ids` (`backend/src/lib/auth/roles.ts:27-28`), `tenant-onboarding-mode`, `install-initial-admin-*` |
| Models | `anthropic-api-key`, `openai-api-key`, `openai-base-url`, `gemini-api-key`, `azure-openai-*`, `openrouter-api-key`, `moonshot-api-key`, `ai-gateway-api-key`, `MIKE_MODEL_CONFIG_JSON` |
| Connectors | `courtlistener-api-token`, `GOOGLE_DRIVE_OAUTH_CLIENT_*`, `GOOGLE_MCP_OAUTH_*`, `SLACK_MCP_OAUTH_*`, `MCP_OAUTH_CLIENT_*`, `github-skill-oauth-client-*` |
| Install-wide, can stay | `download-signing-secret`, `auth-state-secret`, `user-api-keys-encryption-key`, `MCP_CONNECTORS_ENCRYPTION_KEY`, `manifest-signing-key`, `pgrst-db-uri` |

## 9. Infrastructure today (`infra/main.bicep`)

| Resource | Shape |
|---|---|
| Postgres | Flexible Server v16, Burstable B1ms (dev) / B2s (prod), 32 GB, no HA, private endpoint; PgBouncer only on non-Burstable (`infra/modules/postgres.bicep:14-64,88,100`) |
| Storage | One StorageV2 Standard_LRS account, container `documents`, private endpoint (`infra/modules/storage.bicep:25-29,61`) |
| Compute | One Container Apps environment: PostgREST (internal), backend (external, 0.5 vCPU, 0–5 replicas), worker (1 vCPU, 1–3 replicas), Word add-in, migration job (`infra/modules/containerapp-backend.bicep:150-218`) |
| Other | Key Vault (standard), ACR, Log Analytics/App Insights, VNet |
| Absent | API Management, Front Door, Application Gateway |

## 10. Highest-risk leakage paths

1. `service_role` + `BYPASSRLS` + no RLS: one missed filter in 184 `.eq` sites,
   130 helper calls or ~60 RPCs crosses tenants.
2. Email-keyed grants and org invites (`access.ts:107-111`, `orgs.ts:632`)
   cross tenants by design.
3. Whole-table profile reads (`userLookup.ts:28-33`).
4. Install-wide "system" rows and globally unique keys (provenance projects,
   `openai_tool_name`, `db_jobs`/`stream_runs` keys).
5. Download tokens are unbound and never expire (`downloadTokens.ts:111-145`).
6. Jobs carry no tenant, so workers cannot choose the right storage account
   or credentials.
7. Install-wide credentials and admin groups: every tenant would spend the
   operator's LLM keys and `/install` changes would affect all tenants.
8. 17 owner-less child tables.
