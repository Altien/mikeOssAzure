# 001 — Azure platform research for pooled multi-tenancy

**Status:** Research (input to a design decision; not a decision record)
**Researched:** 2026-10-27, from primary sources (learn.microsoft.com, postgresql.org,
pgbouncer.org, docs.postgrest.org, platform.claude.com, developers.openai.com, ai.google.dev).
"Doc date" means the page's `ms.date` or "updated" stamp at fetch time.

**Target shape under evaluation:** one shared, scalable set of Azure resources. Many customer
organisations ("tenants") share one Postgres with a `tenant_id` on nearly every table, enforced
in SQL. Each tenant gets its own Blob storage account. Onboarding happens in a separate
proprietary system. LLM tokens are limited and billed per tenant.

**Current repo shape (checked 2026-10-27):**
- Postgres: PG16 Flexible Server; `pgSku` defaults to `Standard_B1ms` Burstable; storage autogrow `Disabled`; PgBouncer only enabled `if (pgSku.tier != 'Burstable')`. Source: `infra/modules/postgres.bicep`.
- Container Apps: API `minReplicas: 0`, `maxReplicas: 5`; worker 1–3. Source: `infra/modules/containerapp-backend.bicep`.
- Storage: one `Standard_LRS` StorageV2 account with container `documents`. Source: `infra/modules/storage.bicep`.
- Database roles: `service_role` is created `nologin bypassrls` (`backend/migrations/0005_postgres_roles.sql`), and the backend reaches Postgres through internal PostgREST. RLS is "no longer load-bearing" (`docs/Postgres/002-postgrest-and-access-pattern.md`).

---

## 1. Postgres tenant isolation with Row-Level Security (RLS)

### 1.1 Core semantics (PostgreSQL 16 docs)

| Fact | Source |
|---|---|
| With RLS enabled and no policy, "a default-deny policy is used, meaning that no rows are visible or can be modified." | https://www.postgresql.org/docs/16/ddl-rowsecurity.html |
| "Table owners normally bypass row security as well, though a table owner can choose to be subject to row security with `ALTER TABLE ... FORCE ROW LEVEL SECURITY`." | same |
| "Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system." | same |
| "Referential integrity checks, such as unique or primary key constraints and foreign key references, always bypass row security." The docs warn about "covert channel" leaks through these checks. | same |
| A policy's `USING` clause doubles as its `WITH CHECK` unless a separate one is given. Permissive policies combine with OR, restrictive ones with AND. | same |
| Setting `row_security = off` "does not in itself bypass row security"; it errors if a policy would filter rows. This makes it useful as a tripwire. | same |
| Policy expressions run before user-query conditions, "The only exceptions to this rule are `leakproof` functions". Only a superuser can mark a function `LEAKPROOF`. | ddl-rowsecurity; https://www.postgresql.org/docs/16/sql-createfunction.html |
| `CREATE POLICY` says the same: with RLS on and no applicable policy, "a 'default deny' policy is assumed". | https://www.postgresql.org/docs/16/sql-createpolicy.html |

### 1.2 Tenant context per transaction

- `set_config(name, value, is_local)`: "If `is_local` is `true`, the new value will only apply during the current transaction." Source: https://www.postgresql.org/docs/16/functions-admin.html
- `current_setting(name, missing_ok)`: it raises an error for an unknown setting unless `missing_ok` is true, in which case it returns NULL. Source: same page.
- **Typical pattern (not from a single doc).** The policy is `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`, and each transaction starts with `SELECT set_config('app.tenant_id', $1, true)`. If the setting is unset, the comparison yields NULL, so no rows match and the query fails closed.
- The Azure Architecture Center mentions two Azure extensions for tenant context: `session_variable` (session-scoped variables) and `login_hook` (runs a function at login). Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql (doc date 2026-07-07). Both are session-scoped, so they suit transaction pooling less well than transaction-local `set_config`.
- **PostgREST**, which is in this repo's path: request headers and JWT claims are settings "tied to the transaction lifetime" (`current_setting('request.jwt.claims', true)`). A `db-pre-request` function runs after those settings are applied and before the main query, so it can derive `app.tenant_id` or reject the request. Source: https://docs.postgrest.org/en/stable/references/transactions.html

### 1.3 Connection pooling (Azure built-in PgBouncer)

| Fact | Source |
|---|---|
| Built-in PgBouncer 1.25.2 runs on port 6432. Default `pool_mode` is `transaction`, `default_pool_size` 50, `max_client_conn` 5000. | https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-pgbouncer (doc date 2026-10-03) |
| **Not supported on Burstable**: "If you change the compute tier ... to Burstable, you lose the built-in PgBouncer capability." | same |
| Protocol-level prepared statements work in transaction mode once `pgbouncer.max_prepared_statements` > 0; SQL `PREPARE` does not. | same |
| PgBouncer is single-threaded and "a potential single point of failure". It restarts on scale or failover operations. | same |
| In transaction pooling, `SET/RESET`, `LISTEN`, `WITH HOLD` cursors, SQL `PREPARE`, session advisory locks and `PRESERVE/DELETE ROWS` temp tables are all "Never" supported. Protocol-level prepared plans are "Yes". | https://www.pgbouncer.org/features.html |

**Consequence.** Session-level `SET app.tenant_id` is unsafe behind a transaction pooler, because the next client on that server connection inherits it. Use `set_config(..., true)` / `SET LOCAL` inside an explicit transaction, and never set tenant context outside one.

### 1.4 Leakage pitfalls

- **Views run as their owner by default.** "If any of the underlying base relations has row-level security enabled, then by default, the row-level security policies of the view owner are applied". With `security_invoker = true`, the invoking user's policies apply instead. `security_barrier` should be used for views "intended to provide row-level security". Source: https://www.postgresql.org/docs/16/sql-createview.html
- **SECURITY DEFINER functions** "execute with the privileges of the user that owns it". If the owner is a table owner or BYPASSRLS role, the function sees all tenants. Pin `search_path` and exclude writable schemas, with `pg_temp` last. Source: https://www.postgresql.org/docs/16/sql-createfunction.html
- **New tables are unprotected until someone runs `ENABLE`/`FORCE` RLS and adds a policy.** This follows from the default (RLS off) plus owner bypass. A CI or catalog check on `pg_class.relrowsecurity` / `relforcerowsecurity` plus `pg_policies` closes the gap. (This is a recommendation, not a doc quote.)
- **Unique, primary-key and foreign-key checks bypass RLS.** A global `UNIQUE(email)` or `UNIQUE(slug)` reveals another tenant's values through constraint violations. Scope uniqueness as `UNIQUE (tenant_id, …)` and use composite FKs `(tenant_id, x_id)` so a row cannot reference another tenant's parent. Basis: the ddl-rowsecurity covert-channel warning above.
- **The application role** must not be superuser, `BYPASSRLS`, or the table owner (or tables must be `FORCE`d). **In this repo `service_role` is `BYPASSRLS`**, so any policy is inert for backend traffic that runs as `service_role`.

### 1.5 Performance

- The Architecture Center notes that RLS "might affect performance. You might need to create other indexes", and recommends performance testing. Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql
- RLS in a shared database "can be complex to design, implement, test, and maintain. Many multitenant solutions don't use row-level security because of those complexities." Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data (doc date 2026-08-21)
- Composite indexes that lead with `tenant_id` are standard practice for tenant-filtered predicates. They are also a prerequisite for the Citus row-based model (§2.4). No single Microsoft page states this rule; treat it as engineering guidance.

---

## 2. Postgres scaling on Azure: now vs later

### 2.1 Connections per SKU (defaults)

Source: https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits (doc date 2026-07-08). 15 connections are reserved.

| SKU | vCores / RAM | max_connections | user connections |
|---|---|---|---|
| B1ms (current default) | 1 / 2 GiB | 50 | **35** |
| B2s | 2 / 4 GiB | 429 | 414 |
| D2ds_v5 | 2 / 8 GiB | 859 | 844 |
| D4ds_v5 | 4 / 16 GiB | 1,718 | 1,703 |
| D8ds_v5 | 8 / 32 GiB | 3,437 | 3,422 |
| D16ds_v5+ / E8ds_v5+ | — | 5,000 | 4,985 |

- The `max_connections` default is fixed at provisioning time. After a SKU change Microsoft recommends adjusting it manually, and recommends PgBouncer (transaction mode) rather than raising it. Source: same page.
- Storage scale-up "requires a server restart", grows only in 2x increments, and can't shrink. At 95% used the server goes read-only. Source: same page.

### 2.2 Vertical scaling, HA, replicas, storage

- **Compute scaling** restarts the server, with 2–10 minutes of regular downtime. *Near-zero downtime scaling* (default; GA Nov 2023, extended to HA servers Sep 2025) cuts this to roughly 10–30 s. It falls back to regular scaling for Burstable 1–2 vCore sizes. Source: https://learn.microsoft.com/en-us/azure/postgresql/scale/concepts-scaling-resources (doc date 2026-07-14)
- **HA** is zone-redundant (default where available) or same-zone, and is not available on Burstable. SLA is 99.99% zone-redundant, 99.95% zonal, 99.9% without HA. Zone-redundant failover takes 60–120 s. Sources: https://learn.microsoft.com/en-us/azure/postgresql/high-availability/concepts-high-availability (2026-07-22); https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql (2026-03-24)
- **Read replicas** allow up to 5 per primary (cascading up to 30), are asynchronous, and run on General Purpose or Memory Optimized only, not Burstable. Replicas can't have HA. Virtual endpoints are GA (Apr 2024). Source: https://learn.microsoft.com/en-us/azure/postgresql/read-replica/concepts-read-replicas (2026-07-13)
- **Premium SSD v2** reaches up to 80,000 IOPS, 1,200 MB/s and 64 TiB (Premium SSD: 20,000 IOPS, 900 MB/s, 32 TiB). It supports HA and CMK, but has **no storage autogrow**, no Burstable, no long-term backup, and no online migration from Premium SSD. Release notes list it as available in the portal (GA) in Apr 2026. Sources: https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-storage-premium-ssd-v2 (2026-09-25); https://learn.microsoft.com/en-us/azure/postgresql/release-notes/release-notes
- **Storage autogrow** is "only supported for Premium SSD storage tier". Source: https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-storage-premium-ssd (2026-07-08)

### 2.3 Isolation models and stamps (Architecture Center)

- **Data tenancy models** are a shared multitenant DB, sharding, a DB per tenant, or Geode. Shared gives "the highest density ... lowest financial cost" but has scale limits, noisy neighbours, and harder per-tenant restore. "Restoring a single tenant might require you to restore the database to a separate resource and selectively recover that tenant's data." Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data (2026-08-21)
- **Antipatterns:** table-per-tenant, per-tenant columns, manual schema changes. Prefer "a single set of multitenant tables with a tenant identifier column". Source: same.
- **Stamps:** "it's a good practice to create deployment stamps. This recommendation applies even when you use a multitenant database or sharded databases within a stamp." Source: same. The Deployment Stamps pattern is to "Deploy multiple independent copies of application components, including data stores", where each stamp serves "a predefined number of tenants". Source: https://learn.microsoft.com/en-us/azure/architecture/patterns/deployment-stamp (2026-04-28)
- **Customer-managed keys (CMK):** Flexible Server supports CMKs and automatic key-version updates. The Architecture Center text says different keys for different tenants are possible "even when their data is stored in the same database server". This is server-level CMK, so per-tenant keys in practice imply separate servers; see Unverified. Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql

### 2.4 Elastic clusters (Citus on Flexible Server)

- **What it is:** a "managed offering of the open-source Citus extension". It offers **row-based and schema-based sharding**, online rebalancing, DML from any node, and DDL on the coordinator (port 5432). Source: https://learn.microsoft.com/en-us/azure/postgresql/elastic-clusters/concepts-elastic-clusters (2026-07-08)
- **GA:** listed under the **November 2025** release-notes entry (preview from Jan 2025). Source: https://learn.microsoft.com/en-us/azure/postgresql/release-notes/release-notes. The concept page carries no preview banner.
- **Multitenant fit:** row-based sharding distributes by tenant ID but "requires that queries include the distribution column". Schema-based sharding is "well-suited for workloads that have between 1 and 10,000 tenants". Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql
- **Limitations:**
  - Up to 20 nodes self-service (more by support request); no scale-in.
  - **PostgreSQL 17 and 18 only; no major version upgrade.**
  - No storage autogrow; one database per cluster.
  - No VNet injection (Private Link is supported); a single read replica.
  - Zone-redundant HA is supported.

  Sources: https://learn.microsoft.com/en-us/azure/postgresql/elastic-clusters/concepts-elastic-clusters-limitations (2026-09-03); https://learn.microsoft.com/en-us/azure/postgresql/scale/how-to-scale-out
- **Pricing (comparison table):** no coordinator surcharge. General Purpose is $0.09/vCore-hour and Memory Optimized $0.125/vCore-hour; PgBouncer is supported; up to 3,000 connections per node. Source: https://learn.microsoft.com/en-gb/azure/cosmos-db/postgresql/concepts-benefits-database-postgresql (2026-07-27)

### 2.5 Azure Cosmos DB for PostgreSQL — do not use for new work

- "New deployments of Azure Cosmos DB for PostgreSQL are blocked because the service is on a retirement path." Source: https://learn.microsoft.com/en-gb/azure/cosmos-db/postgresql/concepts-benefits-database-postgresql
- It is "not recommended for new projects. The service retires on March 31, 2029." Migrate to elastic clusters. Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql
- **Azure HorizonDB** (disaggregated storage, read-replica pool) is **preview** and "isn't recommended for production". It has no CMK, PgBouncer or VNet injection. Sources: same; https://learn.microsoft.com/en-us/azure/horizondb/overview (2026-06-02)
- `docs/Postgres/001-database-platform-and-sku.md` still lists Cosmos DB for PostgreSQL as an option. It is now obsolete for that purpose.

---

## 3. Blob storage per tenant

### 3.1 Isolation models (Architecture Center, doc date 2026-10-20)

Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/blob-storage

| | Shared containers (path prefix) | Container per tenant | Account per tenant |
|---|---|---|---|
| Data isolation | Low–medium | Medium (container-scoped SAS) | **High** |
| Performance isolation | Low | Low ("most quotas and limits apply to the entire storage account") | **High** |
| Deployment / ops complexity | Low | Medium | **High** |

- "Placing each tenant in a separate container or blob-name prefix doesn't provide dedicated throughput or performance isolation."
- An account per tenant gives "full isolation of storage keys" and lets you "scale your solution beyond the limits and quotas for each storage account". However, "you must also consider the maximum number of storage accounts allowed within a single Azure subscription."
- Built-in capacity metrics are per account, not per container. That makes per-tenant metering simpler with account-per-tenant.

### 3.2 Limits

Source: https://learn.microsoft.com/en-us/azure/storage/common/scalability-targets-standard-account (doc date 2025-10-31, updated 2026-10-16)

| Limit | Value |
|---|---|
| Storage accounts (standard endpoints) per region per subscription | **250 default, 1,000 by quota request** |
| Accounts with Azure DNS zone endpoints per region per subscription | 5,000 (**preview**) |
| Containers / blobs per account | No limit |
| Request rate per GPv2 account (major regions incl. West Europe) | 40,000 req/s (20,000 elsewhere) |
| Private endpoints per account | 200 |

- **Azure RBAC** allows up to **5,000 role assignments per subscription**, "fixed and cannot be increased". Assignments at resource scope count. Source: https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits (2025-10-15)

### 3.3 Access control

- **ABAC conditions on blob role assignments are GA (Oct 2022).** Conditions can test container name, blob path or prefix, blob index tags, and encryption scope name, at the scope of the assignment. "You cannot explicitly deny access to specific resources using conditions." Source: https://learn.microsoft.com/en-us/azure/role-based-access-control/conditions-overview (2025-05-19)
- **User delegation SAS** is signed with an Entra-obtained user delegation key, so no account keys are involved. The key is valid "up to seven days". It is revoked via *Revoke User Delegation Keys* or by removing the signer's RBAC. The caller needs `.../generateUserDelegationKey`, scoped at account, resource group or subscription. Since `sv=2025-07-05`, `sduoid` can bind a SAS to an end user's Entra `oid`, with `skdutid` for cross-tenant users. Source: https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas (updated 2026-09-15)
- The Architecture Center recommends the user delegation SAS with Valet Key pattern, short lifetimes, and logging `x-ms-client-request-id` alongside the tenant ID. Source: blob-storage page above.

### 3.4 Encryption: CMK per account vs encryption scopes

- **Account CMK:** a key in Key Vault or Managed HSM wraps the account encryption key. Key Vault and account "can be in different Microsoft Entra tenants", so a customer-held key is possible. Disabling the key causes data operations to fail with 403. Source: https://learn.microsoft.com/en-us/azure/storage/common/customer-managed-keys-overview (2026-08-18)
- **Encryption scopes** let one account hold "secure boundaries between data that resides in the same storage account but belongs to different customers". A container can enforce its default scope, and each scope uses a Microsoft-managed key or a CMK.
  - Up to 10,000 CMK scopes with auto key-rotation per account.
  - **A scope cannot be deleted.**
  - Scopes are **billed for a minimum of 30 days**, then prorated hourly.
  - Archive tier can't be used with scoped blobs.

  Source: https://learn.microsoft.com/en-us/azure/storage/blobs/encryption-scope-overview (2025-03-10)

### 3.5 Cost and operational implications of many accounts

- The Architecture Center rates account-per-tenant "High" deployment and operational complexity. It points to lifecycle-policy rule limits and server-side copy for moving tenants between stamps. Source: blob-storage page.
- Each extra account multiplies every per-account item: private endpoints and DNS records (this deployment uses private Blob transport), diagnostic settings, CMK configuration, and RBAC assignments (counted against 5,000 per subscription). Concrete prices were not verified; see Unverified.

---

## 4. Identity for many customer organisations

### 4.1 Entra multi-tenant app registration

Source: https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant (doc date 2024-11-13, updated 2026-06-15)

- Set *Supported account types* to "Accounts in any organizational directory", and use the `/organizations` authority (or `/common` to also allow personal MSAs). The App ID URI must be globally unique.
- **Issuer validation:** "The application must validate that the `issuer` property in the published metadata matches the `iss` claim in the token, in addition to the usual check that the `iss` claim in the token contains the tenant ID (`tid`) claim."
- **Consent:** a service principal is created in the customer's tenant on first consent. App-only permissions always need admin consent. `prompt=consent`, sent by a tenant admin, gives the "admin signs up once" onboarding flow. Admins can revoke consent through Enterprise applications.
- **Restricting tenants:** Entra issues tokens to any tenant that consented. The app must reject unknown `tid` values itself, using an allowlist mapping `tid` to an internal tenant record. This follows from the validation guidance above; the page has no built-in allowlist feature.
- MSAL caching gotcha: after first sign-in, request tokens from the tenant-specific authority, not `/common`, or the cache misses.

### 4.2 Architecture Center guidance

Source: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/identity (2025-12-16)

- Building your own identity provider is an antipattern.
- Map users to tenants through invitation codes, email domain, or another identity attribute. "This association should then be stored based on immutable, unique identifiers for both the tenant and the user". Use the object ID (OID), not the UPN.
- Plan for users who belong to several tenants: support explicit tenant switching, prevent accidental cross-tenant access, and make workload identities state their tenant.
- Track entitlements and licensing in the app or a dedicated service, "rather than relying on the identity system".
- Watch identity scale: login storms, and IdP outage behaviour.

### 4.3 Customers without Entra: Entra External ID

- An external tenant is Microsoft's CIAM. Sign-in options include email and password, one-time passcode, Google, Facebook, Apple, Microsoft Entra ID federation, and custom OIDC federation. Source: https://learn.microsoft.com/en-us/entra/external-id/customers/overview-customers-ciam (2026-01-30)
- "Effective May 1, 2025, Azure AD B2C is no longer available for purchase by new customers." Source: same.
- **Implication:** a SaaS that must accept both Entra and non-Entra customers would run two issuers: the multi-tenant workforce app, plus an External ID tenant whose tokens carry the External ID tenant's `tid`. The tenant mapping therefore can't rely on `tid` alone for External ID users (inference).

---

## 5. Per-tenant LLM token limits and billing

### 5.1 Azure API Management (APIM) AI gateway

| Policy | Facts | Source |
|---|---|---|
| `llm-token-limit` | Limits a TPM rate (`tokens-per-minute`) and/or a quota (`token-quota` + `token-quota-period` Hourly–Yearly) per `counter-key`, which can be a policy expression such as tenant ID. Exceeding the rate returns 429; exceeding the quota returns 403. **Supported APIs: OpenAI Chat Completions/Responses, Anthropic Messages (v2 tiers only), Google Vertex AI API.** Counts prompt and completion tokens only. Streaming always estimates both. Counters are **per gateway or region, not aggregated across the instance**. Tiers: Developer, Basic, Standard, Premium (classic and v2), not Consumption. | https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy (2026-04-01) |
| `llm-emit-token-metric` | Sends token metrics to App Insights with up to 5 custom dimensions. In preview it also covers cached and reasoning tokens. **Limits: 100 unique values per dimension and 1,000 time series per namespace; excess is "silently discarded".** Same API schema list. | https://learn.microsoft.com/en-us/azure/api-management/llm-emit-token-metric-policy (2026-09-15) |
| Architecture Center | Derive the tenant from a validated JWT claim or an APIM subscription, never from a client value. Use the tenant as `counter-key`. Use token metrics "for approximate cost showback only when you have a small number of tenants". Otherwise aggregate LLM API logs or "send token usage and the validated tenant identifier to another durable metering pipeline". Partition any semantic cache by tenant. | https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/foundry-models (2026-10-13) |

`azure-openai-token-limit` is the older Azure-OpenAI-only variant. Its current page was not re-read; see Unverified.

### 5.2 Azure-hosted models

- **Azure OpenAI quota** is "assigned to your subscription on a per-region, per-model, per-deployment-type basis" in TPM. RPM is derived from TPM, and the ratio varies by model. PTU quota is also per subscription, region and deployment type, and quota does not guarantee capacity. Sources: https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/quota (2026-05-04); https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/provisioned-throughput (2026-07-15)
- **Claude on Foundry** comes in two variants: "Hosted on Azure" (GA; e.g. Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 4.8) and "Hosted on Anthropic infrastructure". It requires an Azure Marketplace subscription and bills through Claude Consumption Units. The endpoint is `https://<resource>.services.ai.azure.com/anthropic/v1/messages`, using the Anthropic Messages API. Deployment types are Global Standard and Data Zone Standard (US). Limits are counted as RPM, uncached ITPM and OTPM. Source: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models (2026-09-21)
- **Foundry multitenant isolation approaches:** a resource per tenant (in separate subscriptions or a shared one), a shared resource with a project and deployment per tenant, a shared deployment, or a tenant-provided resource. With a shared deployment, "the application layer must entirely enforce any isolation". Test isolation deterministically: "If a cross-tenant test passes only because the model refused to answer, treat it as a failure." Source: foundry-models page above.

### 5.3 Provider-reported usage (for an in-app metering ledger)

| Provider | Non-streaming | Streaming | Source |
|---|---|---|---|
| Anthropic Messages | `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (plus `server_tool_use`) | `message_start` carries the initial usage. "The token counts shown in the `usage` field of the `message_delta` event are *cumulative*." | https://platform.claude.com/docs/en/build-with-claude/streaming |
| OpenAI Chat Completions | `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` | `usage` is "only present when you set `stream_options: {"include_usage": true}`" and appears on the last chunk only | https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events |
| OpenAI Responses | `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` | believed to be on `response.completed`; see Unverified | https://developers.openai.com/api/docs/guides/prompt-caching |
| Google Gemini (generateContent) | `usageMetadata.promptTokenCount` (includes cached), `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount` | present in streamed chunks; which chunk holds the final totals is not stated | https://ai.google.dev/api/generate-content |

APIM's docs warn that if a stream "unexpectedly interrupts or terminates, the captured token counts are inaccurate". The same applies to any app-side meter. Source: llm-emit-token-metric page.

### 5.4 Provider-side spend separation

- **Anthropic workspaces** separate API keys, rate limits (RPM, ITPM, OTPM per model) and monthly **spend limits**, set in the Console. There is a **default maximum of 100 workspaces per organisation** (more via the account team). Workspaces are created through the Admin API; spend limits are set in the Console. Prompt caches are isolated per workspace, including on Foundry. Source: https://platform.claude.com/docs/en/manage-claude/workspaces
- **Anthropic Usage and Cost Admin API** (`/v1/organizations/usage_report/messages`, `/v1/organizations/cost_report`) needs an Admin key (`sk-ant-admin01-…`). Usage comes in `1m`/`1h`/`1d` buckets, grouped by api_key, workspace, model or service_tier. Cost is daily only. Data appears "typically within 5 minutes". Source: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- **OpenAI** has `GET /v1/organization/usage/completions` (`1m`/`1h`/`1d`; `group_by` project_id, api_key_id, model, …) and `GET /v1/organization/costs` (daily). Both need an admin key. Per-project spend hard limits return 429 `project_spend_limit_exceeded`, with "enforcement lags slightly". Per-project rate limits are per model. Sources: https://developers.openai.com/api/reference/typescript/resources/admin/subresources/organization/subresources/usage/methods/completions; https://developers.openai.com/api/docs/guides/spend-limits; https://developers.openai.com/api/docs/guides/rate-limits
- **Gemini:** "Tiers, rate limits, and billing account caps are all determined at the billing account level". Project-level spend caps are "experimental". Source: https://ai.google.dev/gemini-api/docs/billing (2026-09-28)

### 5.5 Billing tenants: Azure Marketplace SaaS metering

- **Metering API:** `POST https://marketplaceapi.microsoft.com/api/usageEvent` and `/api/batchUsageEvent` (max 25 events), `api-version=2018-08-31`. The body has `resourceId` (SaaS subscription), `dimension`, `quantity` (> 0), `effectiveStartTime` and `planId`.
  - "Only one usage event can be emitted for each hour of a calendar day per resource and dimension."
  - Events can only be emitted for the past 24 hours; a duplicate returns 409.
  - Send only usage above the base fee.

  Source: https://learn.microsoft.com/en-us/partner-center/marketplace-offers/marketplace-metering-service-apis (2025-04-21)
- **Metered plans:** flat-rate only (not per-user), max 30 dimensions, and dimension ID, name and unit are immutable once published. Source: https://learn.microsoft.com/en-us/partner-center/marketplace-offers/saas-metered-billing (2026-07-22)
- **Fulfillment v2:** states are PendingFulfillmentStart, Subscribed, Suspended and Unsubscribed. The landing page receives `?token=`, then calls Resolve (token valid 24 h) and Activate. Webhook events are Subscribe, ChangePlan, ChangeQuantity, Renew, Suspend, Unsubscribe and Reinstate, and the webhook must validate the Entra JWT. Sources: https://learn.microsoft.com/en-us/partner-center/marketplace-offers/pc-saas-fulfillment-life-cycle; https://learn.microsoft.com/en-us/partner-center/marketplace-offers/pc-saas-fulfillment-webhook
- **Fit:** the hourly-per-dimension rule means the app must aggregate per-tenant token usage into hourly buckets per meter (e.g. "1k input tokens", "1k output tokens") from its own ledger. Marketplace is a billing sink, not a meter.

---

## 6. Compute (Container Apps)

- **Scaling** (https://learn.microsoft.com/en-us/azure/container-apps/scale-app, 2026-05-19):
  - Replicas per revision default to 0–10, with a configurable max of **1,000**.
  - HTTP and TCP rules default to 10 concurrent requests or connections.
  - Custom rules accept "any ScaledObject-based KEDA scaler"; the examples are `azure-queue` and `azure-servicebus` with managed identity.
  - Polling is 30 s; cool-down 300 s; scale-down stabilisation 300 s.
  - "Vertical scaling isn't supported", and replica counts are "a target amount, not a guarantee".
- **Quotas** (https://learn.microsoft.com/en-us/azure/container-apps/quotas, 2026-10-09): core quotas per environment and environment counts per subscription and region depend on "the age and type of your subscription". Increases are by request.
- **Multitenant guidance** (https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/container-apps, 2026-01-27):
  - The models are shared apps; an app per tenant in a shared environment ("trusted multitenancy"); or an environment per tenant ("hostile multitenancy", strongest isolation, but "low limits" on environments and higher total cost).
  - Dedicated workload profiles can "reserve dedicated resources for a tenant".
  - Revisions should not be used per tenant.
- **Noisy neighbour** "occurs when one tenant's performance is degraded because of the activities of another tenant". Mitigations include the Throttling and Rate Limiting patterns and workload-profile isolation. Sources: https://learn.microsoft.com/en-us/azure/architecture/antipatterns/noisy-neighbor/noisy-neighbor (2025-06-11); storage-data page §2.3.

---

## Implications for Mike for Azure

**Postgres isolation**
- RLS can only be a real boundary if backend traffic runs as a role that is **not** `BYPASSRLS`, not superuser, and not the table owner (or every table is `FORCE`d). Today `service_role` is `BYPASSRLS` (migration 0005). Introduce a tenant-scoped app role and keep `service_role` for migrations and explicit cross-tenant jobs only (§1.1).
- Set tenant context per transaction with `set_config('app.tenant_id', …, true)`, never session `SET`. This is compatible with PgBouncer transaction mode (§1.3). On the PostgREST path, `db-pre-request` can set or validate `app.tenant_id` from a signed claim (§1.2). Policies should read `current_setting('app.tenant_id', true)` so a missing context fails closed.
- Treat RLS as **defence in depth**: also filter by `tenant_id` explicitly in the service facades. Microsoft itself flags RLS complexity (§1.5).
- Make every uniqueness constraint and FK tenant-scoped (`UNIQUE (tenant_id, …)`, composite FKs), because constraints bypass RLS (§1.4).
- Set `security_invoker = true` on views, audit `SECURITY DEFINER` functions with a pinned `search_path`, and add a catalog-based test, next to `architecture.test.ts`, that fails when a public table lacks enabled+forced RLS and a policy (§1.4).
- Lead indexes with `tenant_id`. This also keeps the elastic-cluster row-based sharding path open, since Citus requires the distribution column everywhere (§2.4).

**Postgres scaling: now**
- Production can't stay on Burstable for pooled SaaS:
  - B1ms allows 35 user connections and B2s 414.
  - Burstable has **no built-in PgBouncer, no HA, no read replicas**, and near-zero-downtime scaling falls back for 1–2 vCore Burstable (§1.3, §2.1, §2.2).
  - Note: `docs/Postgres/001` assumes PgBouncer is the default target, but Bicep skips it on Burstable.
- Move the shared production server to General Purpose (e.g. D2ds_v5 to D4ds_v5) with PgBouncer, zone-redundant HA and Premium SSD with autogrow enabled (§2.2).

**Postgres scaling: later**
- Read replicas with a virtual endpoint for read-heavy paths.
- Larger SKUs and Premium SSD v2 for IOPS. This trades away autogrow and requires a migration from Premium SSD.
- Beyond one server: either **deployment stamps** (whole copies of the stack, each holding N tenants; Microsoft recommends stamps even with a shared DB) or **elastic clusters** row-based sharding on `tenant_id`.
  - Elastic clusters are PG17/18 only, with no in-place major upgrade, so plan a PG16 to 17/18 move first.
- Do not consider Cosmos DB for PostgreSQL (retiring 2029-03-31) or HorizonDB (preview) (§2.4–2.5).

**Blob storage**
- Account-per-tenant is the documented strongest isolation and gives per-tenant metrics, keys and CMK. Plan for these constraints:
  - 250 accounts per region per subscription by default (1,000 by request; 5,000 only via preview DNS-zone endpoints).
  - Per-account private endpoints and DNS.
  - The 5,000-assignment RBAC ceiling: assign the backend identity at resource-group scope, or per stamp, rather than per account.
- The provisioning system must create accounts. The app needs only a `tenant_id → account` lookup.
- Issue short-lived **user delegation SAS** from the backend (key ≤ 7 days, revocable), not account keys. Keep the `requireProvider` rule for mutating ops (AGENTS.md) when the provider becomes tenant-resolved.
- A cheaper fallback with weaker performance isolation: a shared account with a container per tenant, an enforced per-tenant **encryption scope**, and ABAC on container name (§3.3–3.4). Encryption scopes cannot be deleted and carry a 30-day minimum charge.

**Identity**
- Convert the Entra app to multi-tenant (`/organizations`).
- Validate `iss` against `tid`, and reject any `tid` absent from a `tenant_directory` table written by the external provisioning system.
- Key users on (`tid`, `oid`). Support admin-consent onboarding (`prompt=consent`).
- Keep the existing groups-overage fallback, which matters per customer tenant.
- Add Entra External ID only when a customer lacks Entra. It brings a second issuer, so the tenant mapping can't be `tid`-only (§4).

**LLM limits and billing**
- There is no token recording today. Build an **in-app metering ledger** first: per request, record tenant, user, provider, model, input, output, cache-read, cache-write and reasoning tokens from the provider `usage` fields.
  - Anthropic `message_delta` usage is cumulative; OpenAI needs `include_usage`.
  - Enforce per-tenant quotas in the backend before calling the provider.
- The Architecture Center itself steers large tenant populations to "another durable metering pipeline" rather than APIM metrics, because of the 100-value dimension cap (§5.1, §5.3).
- APIM `llm-token-limit` is an optional later perimeter control. It covers OpenAI-schema, Anthropic Messages (v2 tiers) and Vertex AI APIs. Its counters are per gateway, it counts only prompt and completion tokens, and it estimates on streams. The Gemini Developer API and arbitrary OpenAI-compatible routers are not confirmed (§5.1).
- Provider workspaces and projects (Anthropic: 100 per organisation by default) suit a few billing tiers or the largest tenants, not one per tenant at scale. The org-wide Key Vault keys stay as they are (§5.4).
- If selling through Azure Marketplace, roll the ledger up hourly per tenant subscription per dimension and post to the metering API (flat-rate plans, ≤ 30 dimensions) (§5.5).

**Compute**
- Shared Container Apps (API + worker) fit pooled tenancy. Raise `maxReplicas` above 5 (limit 1,000) and scale the worker on queue depth.
- Add per-tenant fairness in the Postgres job queue (per-tenant concurrency caps on claims) and per-tenant API rate limits as noisy-neighbour controls.
- Reserve a dedicated workload profile or a separate stamp for tenants that pay for isolation (§6).

---

## Unverified / could not confirm

1. Whether Flexible Server supports **per-tenant CMKs within one server**. The Architecture Center wording implies it, but Flexible Server CMK is configured per server. Treat per-tenant DB keys as requiring separate servers or stamps until confirmed.
2. Exact **elastic clusters GA date**. Only the November 2025 release-notes entry was seen (the official GA blog body did not load). Whether elastic cluster nodes can be Burstable is also unconfirmed.
3. Exact **Premium SSD v2 GA date** for Flexible Server. Release notes say "now available in Azure portal" in Apr 2026, with preview from Nov 2023.
4. **Prices**:
   - per-storage-account overheads (private endpoint hourly and data charges, encryption-scope monthly fee);
   - Flexible Server SKU prices beyond those cited from the comparison table;
   - APIM v2 tier prices.

   The pricing pages were not fetched.
5. Whether `llm-token-limit` / `llm-emit-token-metric` support the **Gemini Developer API** (`generativelanguage.googleapis.com`) or arbitrary OpenAI-compatible routers. The docs list only the OpenAI schema, Anthropic Messages and **Vertex AI**. The current `azure-openai-token-limit` page was not re-read.
6. OpenAI Responses API streaming usage location (`response.completed` → `response.usage`). This rests on a search summary only; platform.openai.com returned 403. Per-project API-key mechanics come from a search snippet.
7. Which Gemini streaming chunk carries the final `usageMetadata` totals. The newer Gemini Interactions API usage field names differ between two Google pages.
8. Numeric default core quotas for Container Apps environments. They are not published; "depend on ... age and type of your subscription".
9. A KEDA `postgresql` scaler on Container Apps. It is plausible ("any ScaledObject-based KEDA scaler") but not named on a Microsoft page.
10. Whether storage accounts with Azure DNS zone endpoints (5,000 per region) have left preview.
