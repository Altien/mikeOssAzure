# Multi-tenant research

This folder researches turning Mike for Azure into a **pooled multi-tenant**
service: one shared, scalable set of Azure resources serving many customer
organisations ("tenants"), where no tenant can ever reach another tenant's
data, and onboarding/billing live in a separate proprietary control plane.

The implementation is on branch `multi-tenant`. The research below records
the starting point and design decisions; current delivery and verification
status lives in the [implementation handoff](../issues/multi-tenant/HANDOFF.md).
The [regional runtime contract](regional-stamp-runtime.md) and
[control-plane contract](control-plane-contract.md) describe the implemented
deployment and provisioning boundaries.

Pooled tenancy is opt-in. Every normal install (Marketplace, local stack)
runs in tenancy mode `single`, the default when no `tenancy-mode` Key Vault
secret or `TENANCY_MODE` is set. Single installs need none of the pooled
setup in this folder. See [Tenancy mode](../deployment.md#tenancy-mode).

## Index

| # | Title | Summary |
|---|---|---|
| 001 | [Azure platform research](001-azure-platform-research.md) | Primary-source facts: Postgres RLS and pooling, Flexible Server scaling and elastic clusters, storage-account-per-tenant limits, multi-tenant Entra, APIM token policies, provider usage reporting, Marketplace metering, Container Apps. |
| 002 | [Codebase readiness](002-codebase-readiness.md) | What the current code does: data access as `service_role` with `BYPASSRLS`, 92-table inventory, email-keyed sharing, storage/jobs/config singletons, LLM metering choke points, leakage risks. |
| 003 | [Target architecture](003-target-architecture.md) | Proposal: four isolation layers (identity → forced RLS → app checks → per-tenant storage), control-plane contract, Postgres now-vs-later, token metering/limits/billing, shared catalog, phasing. |

The work is broken into 23 issues in
[`docs/issues/multi-tenant/`](../issues/multi-tenant/README.md).

## Assessment in brief

1. **Feasible, and the database is the right place to enforce it.** Forced
   Postgres RLS with a `tenant_id` column default taken from the request's
   JWT claims enforces isolation without rewriting most upstream queries. That
   keeps future upstream merges manageable.
2. **The original data layer had no tenant boundary.** Research 002 §10
   records that baseline. The implementation now applies forced tenant RLS,
   tenant-bounded sharing, storage/config/credential isolation and tenant-owned
   jobs; see the implementation handoff for evidence and remaining operations.
3. **Per-tenant storage accounts are sound**, provided placement is owned by
   the control plane (250–1,000 accounts per region per subscription) and the
   app identity is granted at resource-group scope (5,000 role assignments per
   subscription, not raisable).
4. **Don't shard Postgres.** Move to General Purpose with PgBouncer, design
   keys around `tenant_id`, and measure. Because customers choose their
   region (Q4), there is one stamp, with its own Postgres, per region from
   launch; scale within a stamp vertically, and add stamps before sharding.
   Avoid Cosmos DB for PostgreSQL, which is retiring.
5. **Meter tokens in the app; don't rely on a gateway.** Wrap the two LLM
   choke points, write an append-only usage ledger, and enforce budgets with
   reserve-then-reconcile. APIM is an optional second line, not the meter of
   record.
6. **Phases 1–5 ship invisibly** to today's single-tenant installs, so each
   one can be merged and soaked before a second tenant exists.

## Decisions (2026-10-27)

| # | Question | Decision | Effect on the proposal |
|---|---|---|---|
| Q1 | How do customer users sign in? | **Revised 2026-10-27:** standard tiers sign in through an **Altien-owned identity directory** (Entra External ID); only the **enterprise** tier signs in through the customer's own Entra, on request. (First answer was "customer Entra only".) | A user's identity no longer implies a tenant. The tenant key is an internal id; tenant comes from a membership table, or from an enterprise directory link (003 §1). |
| Q2 | Who pays for LLM tokens? | **Both, per tenant**: Altien keys billed as credits by default; a tenant may bring its own key. | All three key modes in 003 §5 stay; the credit model and usage ledger are required. |
| Q3 | Does the single-tenant Marketplace product continue? | **Keep both**, from the same code. | A single-tenant install is a pool of one; phases 1–5 must stay invisible there. |
| Q4 | Where must tenant data live? | **Customer chooses region** from launch. | Deployment stamps per region are needed from launch, not later (003 §4, §8). The control plane places each tenant in a regional stamp, and its storage account in the same region. |
| Q5 | Can one person belong to several tenants? | **No — one at a time** (reconfirmed after Q1's revision). | `tenant_memberships` has one row per user (unique `user_id`). Joining tenant A means leaving tenant B. Someone working for two firms uses two sign-ins (e.g. two email addresses). No tenant switcher. |
| Q12 | Can a tenant admin see and take over all content in their tenant? | **Yes, audited.** | `TenantAdmin` can view and reassign any user's content inside its own tenant (e.g. a departed employee's matters); every such access writes an audit event. RLS still bounds it to the tenant. Altien staff are not a tenant role (003 §1 "Roles"). |
| Q11 | If B signed up separately and then joins A's organisation, what happens to B's data? | **Always start fresh.** B exports their data, leaves tenant B, joins A; tenant B is closed. | No cross-tenant transfer or merge machinery. Rows never change tenant. Needs a self-service export and the offboarding path (003 §1 "Joining another organisation"). |
| Q6 | Must tenants bring their own encryption keys? | **Not now; possibly later.** | Launch with Microsoft-managed keys. Per-account storage keys can be added per tenant later without code change; a per-tenant *database* key would need a dedicated stamp (silo tier). |
| Q7 | Expected first-year scale? | **Fewer than 100 tenants.** | Well under the 250 storage accounts per region per subscription default; one General Purpose Postgres server per regional stamp is enough; Redis and API Management are not needed early. |
| Q8 | Cross-tenant sharing portal at launch? | **No.** | Deferred to phase 7. At launch there is no cross-tenant path of any kind. |
| Q9 | Who curates shared workflows, templates and skills? | **Altien (the product owner) only.** | The cross-tenant catalog is written only by Altien through `platform_service`. Tenants cannot publish to other tenants; within a tenant, the existing org sharing still applies. |
| Q10 | Can a tenant restore *its own* data to an earlier point in time? | **Self-service restore is a premium feature.** Standard tenants get restore on request through a manual support runbook. | Postgres point-in-time restore rewinds a whole server, so in a shared server it would roll back every tenant. Premium tenants therefore get a **dedicated stamp** (the silo tier, 003 §4): their server's point-in-time restore *is* their restore, and the control plane can expose it self-service. Standard tenants: restore a side copy of the shared server and copy that tenant's rows back. All tenants: Blob soft-delete and versioning on every tenant storage account, so files recover independently. |

No questions are open.
