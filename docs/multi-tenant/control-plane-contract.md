# Control-plane integration contract

This is the only supported integration surface for the separate control plane.
Onboarding, invitations, plans, billing, placement decisions and their UI remain
outside this repository. Connect directly to private PostgreSQL using the
restricted `control_plane` login and its own credential from Key Vault. No
password or deployment identifier belongs in source control. The API and worker
continue to use their existing request and platform roles.

## Permissions

The login has no role memberships, schema creation, content-table privileges,
sequence rights or application-function rights beyond the thirteen signatures
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
| `cp_remove_member(p_user_id)` | Removes membership and revokes sessions. The last admin cannot strand other members. |
| `cp_move_member(p_user_id, p_to_tenant)` | Starts fresh as Member in an active destination, retaining verified identity provenance. Revokes sessions. Content, blobs and billing stay in the source tenant. |
| `cp_set_member_role(p_user_id, p_role)` | Updates standard/local membership role, protects the last admin and revokes sessions on change. Enterprise roles must be changed in Entra. |
| `cp_link_identity_source(p_tid, p_tenant_id)` | Links one enterprise directory to a tenant. A directory cannot silently relink. |
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
