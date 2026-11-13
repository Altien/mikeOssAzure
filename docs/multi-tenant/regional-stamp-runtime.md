# Regional stamp runtime and provisioner contract

The same image supports single Marketplace installs and regional pooled stamps.
The repository's Bicep remains the single-tenant Marketplace deployment.
The external provisioner supplies each stamp's Azure resources and runtime
configuration; this document is its implementation checklist.

## Runtime configuration

Names below map to lowercase hyphenated Key Vault names through getConfig.
No customer identifiers or credentials are committed or baked into browser JS.

| Configuration | Pooled requirement |
| --- | --- |
| TENANCY_MODE / tenancy-mode | pooled; must agree with app.install_tenancy.pooled |
| STAMP_ID / stamp-id | Stable stamp identifier; matches the tenant records supplied by the control plane |
| STAMP_REGION / stamp-region | Stable Azure region name; matches database metadata |
| AUTH_PROVIDER / auth-provider | entra in production |
| KEY_VAULT_NAME, AZURE_CLIENT_ID | Stamp vault and user-assigned managed identity |
| SUPABASE_URL | Reachable private PostgREST HTTP endpoint; backend signs its requests |
| POSTGREST_JWT_SECRET / postgrest-jwt-secret | Same secret PostgREST verifies; at least 32 characters |
| API_PUBLIC_URL or BACKEND_PUBLIC_URL / backend-public-url | Public backend HTTPS origin |
| FRONTEND_URL / frontend-url | Public web HTTPS origin |
| WORD_ADDIN_URL / word-addin-url | Public Word HTTPS origin and registered broker redirect |
| POOLED_ONBOARDING_URL / pooled-onboarding-url | Control-plane onboarding HTTPS URL |
| ENTRA_* | Microsoft sign-in (work and personal accounts), including server OAuth credentials; see [pooled authentication](../pooled-authentication.md) |
| ALTIEN_ENTRA_* | Optional External ID path; validated only when ALTIEN_ENTRA_CLIENT_ID is set |
| AUTH_STATE_SECRET, AUTH_SESSION_ENCRYPTION_SECRET, AUTH_HANDOFF_ENCRYPTION_SECRET | Independently provisioned durable keys; normal startup probes verify them |
| DOWNLOAD_SIGNING_SECRET | Durable link-signing key, through the existing startup initializer |
| STREAM_RUN_DATABASE_URL or Key Vault postgres-session-uri | Direct/session PostgreSQL runtime connection for LISTEN; never the PostgREST transaction pool |
| DATABASE_URL, or PG_HOST + PG_MI_USERNAME | Direct migration-owner session connection, supplied only to deployment and maintenance jobs |
| Platform provider credentials | Tier-prefixed vault names (platform-&lt;tier&gt;-&lt;provider-secret&gt;), then the existing global aliases/fallbacks |

The startup metadata RPC lists providers/models enabled by each active
platform-paid tenant's budget price version and model allowlist. Startup checks
that these credentials resolve, including tier credentials. A deliberate
unauthenticated configured model remains supported. BYO credentials do not
become platform requirements. A missing budget or model price still refuses
pooled platform calls under the [credit policy](credit-policy.md); startup does
not invent commercial allowances or prices.

A nonproduction deployment explicitly using AUTH_PROVIDER=local may skip
Azure identity, vault, public HTTPS URL and platform credential checks. It still
requires stamp identity, matching database metadata, successful signed
PostgREST access and enforced tenant RLS. A production local-auth deployment
does not get this exception.

## Startup behavior

API and worker startup await the document-lifecycle guard, then the read-only
probeStampRuntime gate before tenant initialization, listen or queue claims.
The gate reads public.stamp_runtime_metadata() through service_role in both
modes. tenant_app and control_plane cannot execute it.

The gate rejects a database/server mode mismatch, a pooled fallback tenant,
a wrong stamp ID/region, the pooled RLS rollback switch, missing production
configuration and operational config/database errors. Once validated, the
process freezes its tenancy mode. Editing a secret cannot turn an already
running pooled process into a single install, and the request-role boundary
rejects a later RLS rollback edit instead of granting service_role.

The database metadata lives in app.install_tenancy. Runtime cannot change its
pooled flag or stamp identity. Existing single-install first-tenant adoption
retains its narrow fallback/updated_at privilege. Single installs keep the
existing onboarding behavior and can start before that initial fallback exists.

## Deployment sequence

1. Provision private PostgreSQL/PostgREST, vault, networking, managed identity
   and the stamp URLs. Supply migration-owner credentials separately from the
   runtime and control-plane credentials.
2. Apply the complete numbered migrations using the existing migration job.
   After migrations, that job configures stamp metadata and extends ledger
   partitions in one owner transaction, before refreshing PostgREST's schema
   cache and publishing the catalogue. Failure prevents revision activation.
3. For an existing database or a local setup that applied SQL separately, run
   the same owner setup without rerunning migrations or catalogue sync:

       node dist/scripts/configureStampRuntime.js

   From backend source, the equivalent is:

       node --import tsx src/scripts/configureStampRuntime.ts

   Supply DATABASE_URL, TENANCY_MODE and, for pooled mode, STAMP_ID and
   STAMP_REGION through the secure deployment environment. Local validation
   also sets AUTH_PROVIDER=local and NODE_ENV=development. The owner needs
   normal migration/DDL rights; control_plane has no such rights.
4. Activate the API and worker revisions only when the job succeeded. Their
   independent read-only probes must agree with the deployed metadata.
5. Provision tenant records, storage placement, identities and entitlements
   only through the documented [control-plane contract](control-plane-contract.md).

The owner setup locks the metadata row. Once it is pooled, ordinary deployment
cannot downgrade it to single or change an established stamp ID/region.
Absent config therefore cannot silently rewrite a pooled database as single.
A deliberate stamp migration needs a separate reviewed migration-owner
procedure that accounts for its tenants, storage, identity routing and data
residency. It is not a normal configuration edit or confirmation flag.

## Ledger partition maintenance

Deployment calls app.ensure_llm_usage_partitions for the current UTC month
and the next 25 months, then verifies app.tenant_rls_gaps() is empty.
The reusable owner helper is maintainLedgerPartitions; it takes a transaction
advisory lock, keeps partition grants/RLS from migration 0185 and rolls back
on failure. Runtime API/worker credentials never perform partition DDL.

The provisioner must also install an external monthly scheduled maintenance
job, on the first day of each month at 00:00 UTC, running:

    node dist/scripts/maintainUsagePartitions.js

Use the same direct migration-owner DATABASE_URL/MI connection, image version
and private network as deployment. Alert on nonzero exit or a missed run.
This schedule is an external provisioner responsibility; the application does
not create a process timer or use a control-plane credential for DDL.

If rows already in the default partition prevent creating a monthly range,
maintenance fails explicitly and rolls back new DDL. Investigate and reconcile
those rows with their accounting history before retrying. Do not delete usage,
detach the default partition, clear credit holds or suppress the error.
Maintaining the 25-month runway ahead of time avoids this failure.

## Provisioner infrastructure checklist

- Deploy the Container Apps environment, database, vault and tenant storage
  accounts in the chosen stamp region. Decide global versus per-region login
  routing outside the app; each stamp receives its own public URLs.
- Give the app's managed identity Key Vault secret-read rights and Storage
  Blob Data Contributor at the dedicated resource group containing that
  stamp's tenant accounts. Resource-group scope is the deliberate project
  choice so newly provisioned accounts inherit access without one assignment
  per account; that group must contain only accounts belonging to the stamp.
  Azure documents the supported [RBAC scopes](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments).
- Keep Blob transport private. Enable Blob soft delete and versioning on
  every tenant storage account, with an approved retention/lifecycle policy.
  Microsoft documents [soft delete](https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-overview)
  and [versioning](https://learn.microsoft.com/en-us/azure/storage/blobs/versioning-overview).
  Verify these resource properties in the provisioner; no runtime boolean
  claims that they have been configured.
- Use PostgreSQL Flexible Server General Purpose or higher and built-in
  PgBouncer for PostgREST's transaction traffic. Azure supports the built-in
  pooler on General Purpose/Memory Optimized and exposes it on port 6432:
  [PgBouncer documentation](https://learn.microsoft.com/en-us/azure/postgresql/connectivity/concepts-pgbouncer).
  Enable HA before a paying tenant depends on the stamp; HA is the project's
  availability requirement, not an automatically verified runtime flag.
- Keep a direct PostgreSQL/session endpoint on port 5432 for schema migrations,
  monthly DDL and LISTEN/NOTIFY. The runtime rejects known transaction-pool
  ports/options for these connections. The provisioner must verify actual
  routing; a custom proxy's pooling behavior cannot be inferred from its URL.
  Preserve the legacy single-install pgrst-db-uri session source; pooled
  stamps use the separate postgres-session-uri secret.
- Publish approved immutable credit prices and tenant budgets, verify every
  enabled platform tier credential, and test named-member Microsoft sign-in
  (work and personal accounts), linked-directory sign-in and, when configured,
  External ID before onboarding paying tenants.
- Keep secrets in the vault/deployment store, rotate them through a controlled
  rollout, monitor startup/maintenance failures, and test backup/restore
  procedures. Never restore a shared database over unrelated tenants to
  satisfy one tenant's restore request.
