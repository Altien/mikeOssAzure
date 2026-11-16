# Control-plane integration contract

This is the only supported integration surface for the separate control plane.
Onboarding, invitations, plans, billing, placement decisions and their UI remain
outside this repository. Connect directly to private PostgreSQL using the
restricted `control_plane` login and its own credential from Key Vault. No
password or deployment identifier belongs in source control. The API and worker
continue to use their existing request and platform roles.

## Permissions

The login has no role memberships, schema creation, content-table privileges,
sequence rights or application-function rights beyond the nineteen signatures
below. Four views provide narrowly projected metadata. Application table names
and other functions are implementation details, not an integration API.

Like PostgreSQL builtins, installed non-definer `pgcrypto` / `pg_trgm` utility
functions may retain their bootstrap owner's PUBLIC execute rights. A restricted
migration owner cannot revoke those rights. This exception provides no tenant
content access and does not include security-definer functions or other extensions.
All other inherited PUBLIC application-function/table rights are converted to
explicit grants for the existing role tier. New migration-owned functions default
to no PUBLIC execute. `app.tenant_rls_gaps()` includes the control-plane ACL gate.

## Mutations

All arguments use PostgreSQL `text` unless shown otherwise. Functions return
`void`, run atomically, use fixed search paths and are also available to the
existing platform `service_role`. Ordinary request roles cannot execute them.

| Function | Behaviour |
| --- | --- |
| `cp_upsert_tenant(p_tenant_id, p_display_name, p_region, p_stamp)` | Creates an active tenant or updates its display/placement metadata. Never changes status or tenant ID. IDs and stamp names are nonempty identifiers of at most 128 characters; region/stamp may be null. |
| `cp_set_tenant_status(p_tenant_id, p_status)` | Accepts active, suspended or offboarding. Suspension/offboarding revoke sessions and unused Word handoffs in the same transaction. Offboarding cannot be reversed. |
| `cp_set_storage_location(p_tenant_id, p_account, p_container)` | Sets a validated Azure account/container pair. Both null restores install storage fallback. Existing storage registry caching is five minutes; this function does not move bytes. |
| `cp_set_entitlements(p_tenant_id, p_entitlements jsonb)` | Applies the entitlement object below, without resetting usage or outstanding credit holds. |
| `cp_set_secret_refs(p_tenant_id, p_refs jsonb)` | Replaces the entire canonical-name to Key Vault secret-name map. Values must name this tenant's secrets with the `tenant-<tenant_id>-` prefix. Credential values are rejected. Empty object removes references. |
| `cp_set_group_policies(p_tenant_id, p_policies jsonb)` | Replaces group policies with an array of `{groupObjectId: UUID string, role: TenantAdmin or Member}`. Empty array clears policies. Revokes observed member sessions. |
| `cp_set_enterprise_role_source(p_tenant_id, p_source)` | Explicitly selects app_roles or groups. Mike.Admin/Mike.User app roles remain authoritative; groups are an explicitly configured fallback. Revokes observed member sessions. |
| `cp_add_member(p_tenant_id, p_user_id, p_role default 'Member')` | Adds an identity as TenantAdmin or Member. Duplicate identities fail instead of silently moving. |
| `cp_add_directory_member(p_tenant_id, p_directory_id, p_object_id, p_role default 'Member')` | Adds a named Microsoft member (work or personal account): the token's verified `tid` and `oid`, both GUIDs, stored lower-cased. Sign-in admits that exact person with this role before any directory link. Raises 23503 for an unknown tenant, 23505 if the person already has a membership, 22023 for invalid input. Revokes the person's sessions. |
| `cp_remove_member(p_user_id)` | Removes membership and revokes sessions. The last admin cannot strand other members. |
| `cp_move_member(p_user_id, p_to_tenant)` | Starts fresh as Member in an active destination, retaining verified identity provenance. Revokes sessions. Content, blobs and billing stay in the source tenant. |
| `cp_set_member_role(p_user_id, p_role)` | Updates standard/local/named Microsoft membership role, protects the last admin and revokes sessions on change. Directory-linked enterprise roles must be changed in Entra. |
| `cp_link_identity_source(p_tid, p_tenant_id)` | Links one enterprise directory to a tenant. A directory cannot silently relink. The personal-account directory `9188040d-6c67-4c5b-b112-36a304b66dad` is refused (22023). |
| `cp_unlink_identity_source(p_tid)` | Removes the enterprise directory link. |

Except for metadata/status changes, offboarding tenants reject new configuration
and content writes. Membership/directory changes retain the existing one-tenant
identity and last-admin rules. To move a member, arrange their self-service export
first; this API does not transfer rows or storage between tenants.

### Entitlement object

Unknown fields and invalid types fail the entire transaction. The following
camelCase fields map to the existing tenant settings; absent settings fields keep
their existing value. Arrays and maps replace their corresponding value.

| Field | Value |
| --- | --- |
| keyMode | platform or byo |
| tier | Optional credential-tier identifier, or null to inherit |
| modelAllowlist | Array of exact application model IDs; null inherits policy, empty array permits no models |
| enabledConnectors | Array of connector names, or null to inherit |
| featureFlags | Object containing boolean values |
| config | Non-secret configuration map accepted by the tenant-settings validator; endpoints/scopes only |
| budget | The object below, or absent/null to remove the budget policy |

A budget requires `monthlyCredits` (nonnegative finite decimal string) and
`priceVersion` (an already published version). Optional `perUserCredits` is a
nonnegative finite decimal string or null. Optional `softThreshold` is a decimal
string between zero and one or null. Numbers, unknown fields and non-finite values
are rejected. PostgreSQL performs all decimal arithmetic. For example:

```json
{
  "keyMode": "byo",
  "featureFlags": { "exampleFeature": true },
  "modelAllowlist": null,
  "budget": null
}
```

Budget policy updates never clear counters or reservations. A missing budget
refuses pooled platform-paid calls; BYO continues without platform credits. Price
publication remains a separate service-role operator operation, not a
control-plane grant. See [credit policy](credit-policy.md).

## Support reports

A user can report an issue with one assistant response and, by ticking one box,
allow support to inspect the conversation up to and including that response and
the documents of its project (or, without a project, the documents attached to
the chat up to that response) for 14 days. The database enforces consent, the
cut-off, expiry and withdrawal; the report ID alone determines the tenant. The
`p_actor` argument (nonempty, at most 200 characters) names the support person
and is recorded with every read except the listing in an append-only access log.

| Function | Behaviour |
| --- | --- |
| `cp_list_support_reports(p_since timestamptz default null, p_tenant_id default null, p_limit integer default 100)` | Reports created after `p_since`, oldest first, at most 500: report_id, tenant_id, user_id, chat_id, project_id, message_id, description, allow_conversation, allow_documents, created_at, access_expires_at, withdrawn_at, access_live. |
| `cp_read_support_report(p_report_id uuid, p_actor)` | `jsonb`: the report (with consent_text) and a content-free trace of the chat up to the response (message shape, stream runs, audit status, usage, credit reservations). Needs no consent. |
| `cp_read_support_conversation(p_report_id uuid, p_actor)` | The chat's messages up to and including the reported response. Needs live conversation consent. |
| `cp_list_support_documents(p_report_id uuid, p_actor)` | The in-scope documents' current-version metadata and text status. Needs live document consent. |
| `cp_read_support_document(p_report_id uuid, p_document_id uuid, p_actor)` | `jsonb`: one in-scope document's metadata, blob paths and extracted text when ready. Needs live document consent. |

Errors: 22023 invalid actor, 23503 unknown report or out-of-scope document,
42501 missing consent, withdrawn or expired access.

## Read-only views

| View | Columns |
| --- | --- |
| cp_daily_usage | tenant_id, usage_date (UTC admission day for budgeted calls), feature, provider, model, key_mode, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, credit_period, credits |
| cp_audit_events | id, tenant_id, created_at, action, status, surface |
| cp_storage_locations | tenant_id, display_name, status, region, stamp, storage_account, storage_container, purged_at |
| cp_user_counts | tenant_id, users, admins (observed membership counts) |

The views use the platform owner's rights for cross-tenant reporting, with fixed
projections. Audit detail, actor IDs, email, titles, prompts, document/chat IDs,
provider payloads and secret references are not exposed. Enterprise counts reflect
observed sign-ins rather than the customer's entire directory.

## Offboarding and erasure

Setting offboarding blocks authentication, revokes sessions, fences new content
INSERT/UPDATE operations and atomically enqueues a deduplicated `tenant.purge`
job. The fenced worker RPC requires the actual tenant/job/claim token and a live
lease; request and control-plane roles cannot call it. It deletes tenant content
and dependent records in one transaction, retrying foreign-key and ownership-guard ordering within the pass.
An interrupted/failed transaction is safe to retry. Delivery retries without a
terminal attempt limit; failed purge receipts are retained for diagnosis.

The tenant row, budget policy, credit counters/reservations and usage ledger remain.
Actor identifiers in billing are replaced with tenant-scoped random pseudonyms.
Account erasure similarly pseudonymises existing billing rows and retains its
scoped tombstone. A database insert guard and shared usage lock cover calls that
finish after erasure, including late credit settlement; user counter subjects and
reservation ownership follow the same pseudonym. Holds and exact credit amounts
remain intact. The request/platform roles still cannot update the ledger.

Wait until `cp_storage_locations.purged_at` is non-null, then delete the tenant's
storage account using the external infrastructure control plane. This repository
does not delete Azure accounts. Do not delete a shared install fallback account;
its ownership/placement must first be resolved externally. Retrying the offboarding
status call deduplicates live work and can enqueue another attempt if an older
worker left a failed job. After purge, late billing remains acceptable but content
writes remain fenced. Offboarding never reactivates the tenant.

## Development adapter

`scripts/multi-tenant/control-plane.mjs` accepts a JSON object with a nonempty
`tenants` array. Each tenant accepts tenantId, displayName, region, stamp, storage
(account/container), entitlements, secretRefs, groupPolicies, enterpriseRoleSource,
members, identitySources and status. It applies all tenants in one transaction
using only the functions above. Set `CONTROL_PLANE_DATABASE_URL` from secure
operator configuration; legacy `DATABASE_URL` is accepted as a fallback. The CLI
verifies `current_user = control_plane`.

The module exports `applyTenantConfiguration(db, config)` for local smoke tests
and `localUserId(email)`. Development members may supply email instead of userId;
the email is normalised and hashed exactly as the real local-login route does.
This convenience creates no identity provider account and implements no commercial
onboarding flow. Production identities use their verified provider user IDs.
