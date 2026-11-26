# 003 — Target architecture for a pooled multi-tenant install

**Status:** Proposal (research; nothing implemented). Evidence for the current
code is in [002](002-codebase-readiness.md); Azure platform facts and limits
are in [001](001-azure-platform-research.md).

## Goal and non-negotiables

One shared, scalable set of Azure resources serves many customer
organisations. Each organisation is a **tenant** (all Altien users are one
tenant; all XYZ LLC users are another).

1. A tenant can **never** read, write, list or infer another tenant's files,
   conversations, settings, memory, audit trail, usage or anything else.
2. Cross-tenant exchange happens **only** through an explicit sharing portal
   that copies content into a neutral space. No direct access, no shared row,
   no shared blob, ever.
3. Onboarding, customer creation, invites, plans and billing live in a
   **separate proprietary control plane**, outside this repository. This repo
   only consumes a narrow contract.
4. Sensitive files are **physically separated**: one Blob storage account per
   tenant.
5. The database is shared, with `tenant_id` on every tenant-owned table.
6. Per-tenant LLM token limits and per-tenant token billing.
7. The single-tenant marketplace product keeps working from the same code: it
   is simply a pool with one tenant.

## The model in one picture

```
                 ┌────────────────────────────────────────────┐
 proprietary     │  Control plane (separate repo, private IP) │
 (not in repo)   │  onboarding · invites · plans · billing    │
                 │  stamp/storage placement · provisioning    │
                 └──────┬───────────────────────────▲─────────┘
        tenant registry │ (cp_* SQL functions,       │ usage + audit
        entitlements    │  control_plane role)       │ events (pull/outbox)
                 ┌──────▼───────────────────────────┴─────────┐
 this repo       │  Mike API + worker (shared Container Apps)  │
                 │  token → tenant context → per-request JWT   │
                 └──────┬───────────────────────┬─────────────┘
                        │ JWT{role, tenant_id}  │ tenant → account map
                 ┌──────▼──────────┐   ┌────────▼─────────────────────┐
 shared data     │ PostgREST →     │   │ stmiketenantA  stmiketenantB │
                 │ Postgres (RLS,  │   │ (one storage account/tenant, │
                 │ FORCE, tenant_id│   │  private endpoint each)      │
                 │ on ~80 tables)  │   └──────────────────────────────┘
                 └─────────────────┘
```

## 1. Tenant isolation: four independent layers

The rule: **any single layer failing must not leak data.** Today there is
effectively one layer (hand-written TypeScript filters); the proposal adds
three that do not depend on every query being written correctly.

### Layer 1 — Tenant context from identity, never from input

- **Decided (README Q1, revised): two ways to sign in.**
  - **Standard tiers:** an Altien-owned Entra External ID directory (001
    §4.3) — email code, Google, Microsoft account, etc. The user's identity
    is the `oid` in Altien's directory and belongs to no tenant.
  - **Enterprise tier (on request):** the customer's own Entra directory,
    via the multi-tenant app registration. Entra has no built-in allow-list,
    so the backend checks that `iss` matches `tid` and that the `tid` is
    linked to a tenant (001 §4.1). Users from a linked directory can only
    land in that tenant.
- Resolve the tenant from the validated token and our own tables only. Never
  accept a tenant id from a header, body, path or query string:
  - enterprise token → `tenant_identity_sources(tid → tenant_id)`;
  - Altien-directory token → `tenant_memberships(user_id → tenant_id)`;
  - no membership → onboarding (control plane), never a default tenant.
- **Tenant key = `tenants.tenant_id` (text), an internal id** assigned by the
  control plane. Existing single-tenant installs keep their current value
  (the `tid`), so `tenants` and the Altien Skills tables
  (`backend/migrations/0027_altien_skill_imports.sql:25`) need no change.
  `local`/`supabase` auth mode uses one fixed configured key.
- **Decided (README Q5): one tenant at a time.** `tenant_memberships` has a
  unique `user_id`. Rows carry `(tenant_id, user_id)`.
- **Joining another organisation (README Q11: always start fresh).** B
  signed up alone (tenant B) and later joins A:
  1. A's admin invites B, or B requests to join and A's admin approves
     (control plane; verified domains can offer "Join XYZ's workspace" at
     sign-up so most duplicates never happen).
  2. B exports their data (self-service export).
  3. The control plane moves B's membership to A and starts offboarding of
     tenant B (purge rows, delete its storage account). B's sessions are
     revoked, so the next sign-in lands in A.
  4. Billing and usage history stay with tenant B's record.

  Rows and blobs never change tenant, which keeps isolation provable; there
  is no transfer or merge machinery.
- **Upgrade to enterprise** (deferred): linking a standard tenant's existing
  users to their corporate Entra accounts needs account linking by verified
  email at first corporate sign-in.

**Roles.** Today there are three unrelated "admin" notions: the app's
`TenantAdmin` from install-wide group lists (`backend/src/lib/auth/roles.ts:25-58`,
used only by Skills management, `backend/src/altien/skills/router.ts:112-116`),
the `/install` operator, and upstream org roles. In pooled mode:

- **Two tenant roles, unchanged names:** `TenantAdmin` and `Member`.
  - Standard tiers: `tenant_memberships.role`. The tenant's creator is the
    first admin; admins change roles through the control plane; the last
    admin cannot be removed or demoted.
  - Enterprise tier: **Entra app roles** on the customer's enterprise app
    (a "Mike Admin" role arrives in the token's `roles` claim). This avoids
    group-id lists and the groups-overage failure entirely. Group-to-app-role
    assignment may need Entra ID P1 in the customer tenant (to verify);
    `tenant_group_policies` remains the fallback.
- **What `TenantAdmin` can do** (README Q12): manage members and roles (via
  the control plane), view usage and budgets, tenant settings within the
  plan's entitlements, Skills management (as today), and **view or reassign
  any content in the tenant, with every access audited**. RLS still bounds
  all of it to the tenant.
- **Altien staff are not a tenant role.** No Altien account has an in-app
  path to tenant content; platform administration happens in the control
  plane. Support access, if ever offered, is time-boxed, approved by a
  tenant admin and audited (deferred).
- `/install` is off in pooled mode. Upstream org roles stay as teams inside
  a tenant; an org admin is not a tenant admin.
- `tenantAccess` (already in the repo, `backend/src/middleware/tenantAccess.ts`)
  becomes the gate that checks tenant `status` and plan entitlements on every
  request. `tenant_group_policies` (unused today) becomes the per-tenant
  role mapping, replacing the install-wide `entra-*-group-ids` keys.

### Layer 2 — The database enforces tenancy (RLS, fail-closed)

This is the layer that makes "never" defensible, and it also turns out to be
the **least invasive for upstream merges**.

**Column default from the session.** Every tenant-owned table gets:

```sql
tenant_id text not null
  default (current_setting('request.jwt.claims', true)::json ->> 'tenant_id')
  references public.tenants(tenant_id)
```

Existing upstream insert code does not have to set `tenant_id`: the database
fills it from the request context. If the context is missing, the default is
NULL and the `not null` constraint rejects the write — fail closed.

**Forced RLS on every tenant-owned table:**

```sql
alter table public.chats enable row level security;
alter table public.chats force row level security;
create policy tenant_isolation on public.chats
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());
```

`app.current_tenant_id()` reads the claim with `current_setting(..., true)`
and returns NULL when absent, so a request without tenant context sees zero
rows rather than every row.

**A role that cannot bypass it.** Today every request runs as `service_role`
(`BYPASSRLS`). Introduce `tenant_app` (no `BYPASSRLS`, not a table owner) as
the role for all tenant traffic. Keep a separate `platform_service` role with
`BYPASSRLS` for the few genuinely cross-tenant operations (migrations,
catalog sync, job claiming, control-plane functions), and make an
architecture test reject any use of it outside an explicit allowlist.

**PostgREST verifies a JWT again.** Instead of stripping auth headers and
trusting the network (`backend/src/lib/supabase.ts:49-59`), the backend mints
a short-lived (e.g. 60 s) JWT per request — `{role: "tenant_app",
tenant_id, sub: user_id}` — signed with a secret PostgREST verifies.
PostgREST sets `request.jwt.claims` with transaction scope, so this works
with its connection pool and with PgBouncer transaction mode. The change in
TypeScript is concentrated in one place: `createServerSupabase()` becomes
`dbForRequest(principal)` (plus `dbForPlatform()` for the allowlist).

**Structural guarantees on top of RLS:**

- **Composite foreign keys** — `(tenant_id, project_id) references
  projects(tenant_id, id)` — make it impossible for a child row in tenant A
  to point at a parent in tenant B, even through a bug in `platform_service`
  code.
- **Denormalised `tenant_id` on the 17 owner-less child tables** (messages,
  versions, cells, …) so their policies are a column compare, not a join.
- **Constraints are not filtered by RLS.** Unique, primary-key and
  foreign-key checks see every row regardless of policy (001 §1.4), so a
  global unique leaks existence across tenants ("that name is taken") and a
  single-column FK can cross tenants. Both are fixed by putting `tenant_id`
  into the constraint, below.
- **Views** need `security_invoker = true`, or they apply the view owner's
  RLS rather than the caller's (001 §1.4).
- **Tenant-scoped uniqueness** — `unique(tenant_id, …)` replaces global
  uniques (`openai_tool_name`, provenance keys, `db_jobs` dedupe,
  `stream_runs.run_key`, profile email lookups).
- **Indexes lead with `tenant_id`**, which is also the shape a later move to
  sharding needs (§4).
- **`security definer` functions (~93):** change the function owner to a
  non-`BYPASSRLS` role and rely on `FORCE ROW LEVEL SECURITY`, or convert to
  `security invoker`. Each needs review; this is the largest single item.

**A migration gate.** Add a test that inspects the catalog after migrations
and fails if any `public` table lacks `tenant_id`, `FORCE ROW LEVEL SECURITY`
or a `tenant_isolation` policy, unless it is on an explicit global-catalog
allowlist (the 6 catalog tables). New upstream tables then cannot slip in
unprotected.

### Layer 3 — Application checks stay, and learn about tenants

- Keep all existing user/grant checks (`backend/src/lib/access.ts`).
- Sharing and org invites resolve the target **inside the current tenant
  only**. Granting access to an email that is not a user of the same tenant
  fails, instead of creating a dangling grant that a same-email user in
  another tenant could later satisfy (`access.ts:107-111`, `orgs.ts:632`).
- Replace whole-table reads (`backend/src/lib/userLookup.ts:28-33`) with
  tenant-filtered queries (RLS would do this anyway).
- Download tokens carry `{tenant, user, path, exp}` and are checked against
  the current principal (`backend/src/lib/downloadTokens.ts:111-145`).
- Install-wide "system" owners (`system:external-provenance`,
  `system:skill-library:*`) become per-tenant system rows.

### Layer 4 — Physical separation of files

See §2. Even a full database bug cannot hand tenant A a blob from tenant B
if the blob client is chosen from the *tenant context*, not from the stored
path, and the path is asserted to belong to that tenant.

### Proving it: the cross-tenant canary suite

Seed two tenants with identical fixtures. Enumerate every route in
`buildApp()` and call it as tenant A with tenant B's ids. Every call must
return 404/403 and zero rows. Run it in CI on every PR and on every upstream
sync. This is the test that makes "never" a checked claim rather than a hope.

## 2. Storage: one account per tenant

**Why an account, not just a container.** Per-account gives separate network
endpoints, separate RBAC scope, per-tenant customer-managed keys, per-tenant
region (data residency), clean deletion on offboarding (delete the account),
and **per-tenant storage cost for free** through tags and Cost Management.

**Costs and limits to plan for** (001 §3.2, §3.5):

- 250 storage accounts per region per subscription by default, 1,000 on
  request. Beyond that, add subscriptions (or stamps).
- Role assignments are capped at 5,000 per subscription and cannot be
  raised, so **do not** grant the app identity per account. Grant it once at
  the resource-group (or stamp) scope that holds the tenant accounts.
- Every account needs its own private endpoint and DNS record, each with a
  monthly cost (price not confirmed in 001).

The control plane therefore owns **placement**: it chooses the
subscription/region/resource group for each new account and records it in
the tenant registry, so the cap is a capacity-planning number, not a wall.

**In the app:**

- Replace the provider singleton (`backend/src/lib/storage.ts:449-461`) with
  `storageFor(tenantId)`, a cached map of tenant → `BlobServiceClient`, built
  from the tenant registry (account name/endpoint), using the app's managed
  identity.
- Prefix every key with the tenant (`t/{tenantId}/documents/{userId}/…`) and
  assert the prefix on every read/write — defence in depth if a path ever
  crosses accounts.
- Job payloads carry `tenant_id` (the `db_jobs` row gets it by default from
  the enqueuing request), so workers pick the right account.
- **Honest limit:** one app identity has data-plane access to every tenant
  account, so per-account separation contains breaches, deletion and keys,
  but does not by itself stop an app bug. Layers 1–3 do that. If a customer
  demands identity-level separation, that is the silo tier (§4).
- If browsers ever download directly from Blob instead of through the
  backend proxy, use **user delegation SAS** (Entra-backed, revocable, can be
  bound to one user) — never account keys (001 §3.3).

**Cheaper fallback** if tenant count outgrows the account economics: one
account per *stamp*, one container per tenant, one **encryption scope** per
tenant (per-tenant key, optionally customer-managed). Same code path —
`storageFor(tenantId)` returns a container client instead of an account
client. Caveat: encryption scopes cannot be deleted (only disabled) and bill
a 30-day minimum, so offboarding is less clean (001 §3.4).

**Database encryption keys:** customer-managed keys on Flexible Server are
per *server*, so a tenant that demands its own database key needs its own
server — i.e. the silo tier (§4).

## 3. Boundary with the proprietary control plane

The repo exposes a **narrow, documented contract** and contains none of the
onboarding logic.

| Direction | Contract | Notes |
|---|---|---|
| Control plane → app | `cp_*` SQL functions callable only by a `control_plane` role: `cp_upsert_tenant`, `cp_set_tenant_status` (active/suspended/offboarding), `cp_set_identity_sources`, `cp_set_storage_location`, `cp_set_entitlements` (model allow-list, token budgets, feature flags), `cp_set_tenant_secret_refs` | Thin and stable. Alternatively an internal admin HTTP API authenticated with an Entra client-credentials token. |
| Control plane → app | Per-tenant secrets (BYO LLM keys, connector OAuth clients) as Key Vault **secret references** (names), never values in the DB | Key Vault limits may push to one vault per stamp or per large tenant. |
| App → control plane | Append-only `usage_events` and `audit_events` with `tenant_id`, exposed through a pull view or an outbox to Event Hubs/Service Bus | The control plane rates, invoices and reconciles. |
| Users | Standard tiers: the control plane writes `tenant_memberships` (invites, join requests, verified-domain prompts, moves between tenants). Enterprise: first sign-in from a linked directory just-in-time creates the user if the tenant's group policy matches. | Invite UX, consent links, domain verification and admin onboarding are control-plane IP. |

`/install` stays the single-tenant marketplace operator tool and is disabled
in pooled mode, where the control plane owns that job.

## 4. Postgres: what to do now vs later

**Recommendation: do not shard. Design the schema so you can, then scale
each server vertically until real traction says otherwise.**

**Decided (README Q4): customers choose their region from launch.** That
means one **regional stamp** per offered region from day one: its own
Container Apps environment, its own Postgres server, and the storage
accounts of the tenants placed there. There are several Postgres servers
from launch, but each is an ordinary single server, one per region, not
shards. The control plane records each tenant's stamp and routes sign-in to
it (one global entry point such as Front Door, or a per-region hostname).
Tenant data never leaves its stamp; only the Altien catalog is replicated
to every stamp.

Now (within each regional stamp):

- Single Flexible Server, **General Purpose** (not Burstable). Burstable has
  no built-in PgBouncer, HA or read replicas, and B1ms allows only 35 user
  connections (001 §2.1–2.2); the Bicep already skips PgBouncer on
  Burstable (`infra/modules/postgres.bicep:88`). Scaling compute later is a
  restart of roughly 10–30 s.
- Zone-redundant HA once a paying tenant depends on it; point-in-time restore
  is server-wide, so per-tenant restore means "restore to a side server and
  copy one tenant's rows" — write that runbook early. **Decided (README
  Q10):** self-service restore is premium and is delivered by putting the
  tenant on a dedicated stamp, where server restore equals tenant restore;
  standard tenants use the runbook. Turn on Blob soft-delete and versioning
  on every tenant storage account.
- Sizing: fewer than 100 tenants in year one (README Q7) fits one General
  Purpose server per regional stamp; no read replicas, Redis or API
  Management needed at launch.
- `tenant_id`-leading indexes and composite keys (§1) — free now, essential
  later.
- Measure per-tenant load from day one (`pg_stat_statements` + tenant tags in
  App Insights) so the scaling decision is data-driven.

Later, in this order, each triggered by a measured need:

1. **Vertical scale** and storage/IOPS tuning — minutes of work, no code.
2. **Read replica** for heavy read RPCs (`get_*_overview`) if reads dominate.
3. **More stamps in a region** — when one regional stamp fills up, open a
   second in the same region; the control plane places new tenants there.
   Stamps also answer noisy neighbours, storage-account caps and blast
   radius, and give a **silo tier** for free: a premium tenant gets a
   dedicated stamp running the same code.
4. **Sharding inside one stamp** (elastic clusters / Citus, distributed by
   `tenant_id`) only if a single stamp's database outgrows the largest
   Flexible Server. Because every table already has `tenant_id` in its keys,
   this is a migration rather than a rewrite. Elastic clusters are GA but
   PG17/18 only, with no in-place major upgrade and a 20-node self-service
   cap (001 §2.4); we are on PG16, so this path also implies a version
   move. **Do not** use Azure Cosmos DB for PostgreSQL: it blocks new
   deployments and retires on 2029-03-31 (001 §2.5).

Stamps before sharding: fewer moving parts, no distributed-SQL constraints on
upstream queries, and the control plane already has to do placement for
storage.

## 5. Tokens: limits, metering and billing

### Meter inside the app (the source of truth)

- Wrap the two choke points `streamWithProvider` / `completeWithProvider`
  (`backend/src/lib/llm/providers.ts:363,430`). Usage arrives on the AI SDK
  `finish-step` event (`backend/src/lib/llm/aiSdk.ts:549`) and on
  `result.usage` for non-streaming calls.
- Add `tenantId`, `userId` and a `feature` tag (chat, tabular, workflow,
  memory consolidation, citation verification, skill import) to
  `StreamChatParams`.
- Write an append-only, month-partitioned `llm_usage_events` row per call:
  tenant, user, feature, provider, model, input / output / cache-read /
  cache-write tokens, request id, latency, and the price-table version used.
- Count **every** model call, including background ones (memory
  consolidation, extraction), and aborted streams (charge what was produced).

### Enforce limits before the call

- **Budgets** per tenant (monthly tokens or credits) and optional per-user
  caps, from the control plane's entitlements.
- **Reserve, then reconcile:** before a call, reserve an estimate (prompt
  tokens + `max_tokens`) against the tenant's remaining budget in one atomic
  SQL update; after the call, release the difference. Prevents a burst of
  parallel tabular-review cells from overshooting the budget.
- **Rate limits** (tokens per minute) per tenant need a shared store: the
  current limiters are in-memory per replica (`backend/src/app.ts:87-140`).
  A Postgres token bucket is enough initially; Azure Managed Redis later.
- **Model allow-list per tenant** (from entitlements) replaces the
  install-wide `MIKE_MODEL_CONFIG_JSON` (`backend/src/lib/llm/registry.ts:23`).
- **Fair queueing:** the worker claims jobs round-robin by tenant with a
  per-tenant concurrency cap, instead of one global FIFO
  (`backend/src/lib/dbq/runner.ts:326`).

### Whose keys pay

Support three modes per tenant, chosen by the control plane:

| Mode | Who holds the key | Billing |
|---|---|---|
| **Platform-provided** (default) | Altien keys, split into provider workspaces/projects **per plan tier or per large tenant** (Anthropic allows 100 workspaces per organisation by default, so not one per tenant — 001 §5.4) | Altien bills the tenant from `llm_usage_events`; the provider's per-workspace spend limits and usage reports act as an independent second meter and a hard stop. |
| **BYO key** | Tenant's own Anthropic/OpenAI/Azure OpenAI key, as a Key Vault secret reference | Tenant pays the provider; Altien bills platform fee only; metering still runs for quotas and support. |
| **Tenant's Azure subscription** | Tenant's Azure OpenAI / Foundry deployment | Same as BYO; usage appears on their Azure bill. |

This keeps the organisation-wide credential model (see the
`mike-azure-credential-boundary` skill): credentials are per **tenant**, not
per user.

### An AI gateway in front of the providers (optional, later)

Azure API Management's `llm-token-limit` policy covers OpenAI Chat/Responses,
Anthropic Messages (v2 tiers only) and Vertex AI (001 §5.1). It is not a
meter of record: counters are per gateway instance, streaming token counts
are estimated, and the token-metric policy silently drops data past 100
distinct values per dimension — Microsoft's own guidance sends larger tenant
counts to an app-level metering pipeline. Treat APIM as an optional second
enforcement point once tenants are many; the app already knows tenant, user
and feature, which the gateway does not.

Provider usage details the meter must handle (001 §5.3): cache-read and
cache-write tokens are reported separately; Anthropic streaming usage is
cumulative on `message_delta`; OpenAI streaming only reports usage when
`include_usage` is requested.

### Billing ideas

- **Credits, not raw tokens.** Convert each model's input/output/cache prices
  into a single credit unit with a versioned price table, so plans read
  "50,000 credits/month" regardless of model mix, and a price change does not
  rewrite history.
- Plans: included credits + overage, seat fee, and storage over a threshold
  (per-tenant storage accounts make storage cost exact).
- Marketplace customers can be billed through the Azure Marketplace metering
  service, which accepts at most one event per hour per subscription per
  dimension (≤30 dimensions, flat-rate plans), so the control plane sends
  hourly roll-ups from the app's ledger (001 §5.5). Direct customers are
  invoiced by the control plane. Both read the same per-tenant aggregates.
- Surface usage to tenant admins in-app (read-only, own tenant only).

## 6. Shared resources: workflows, templates and skills

- **Altien catalog** (global, read-only to tenants): `mike_workflows`,
  `mike_workflow_assets`, `workflow_addons*`, CourtListener indexes, preset
  templates. These are the only tables on the RLS allowlist, readable by all
  tenants, writable only by `platform_service`.
- **Decided (README Q9): Altien alone curates the catalog.** Tenants cannot
  publish to other tenants.
- **Tenant library**: a tenant admin can publish a workflow/template/skill to
  everyone in *their* tenant (the upstream orgs feature and `tenant_id`-scoped
  Skills already point this way).
- **Copy-on-customise**: adopting a catalog item creates tenant-owned rows
  (today's `install_missing_default_workflows` already copies per user).
  Tenants never write to catalog rows, so a catalog item cannot carry data
  between tenants.
- **Cross-tenant sharing portal (deferred, README Q8; not at launch):** a
  separate "exchange" space with
  its own storage account. Sharing = an explicit, audited *export* of a copy
  into the exchange; the recipient tenant *imports* a copy. No live
  references, revocation means deleting the exchange copy, and both sides see
  it in their audit trail.

## 7. Upstream compatibility

This is the largest divergence from upstream so far, so concentrate it where
upstream rarely touches:

- RLS + column defaults keep most upstream TypeScript unchanged; the tenant
  context arrives through the per-request client, not through every query.
- The migration gate and canary suite catch new upstream tables and routes
  that would otherwise be unprotected.
- Expected touch points: `lib/supabase.ts`, `lib/storage.ts`,
  `lib/downloadTokens.ts`, `lib/llm/providers.ts`, `lib/dbq/runner.ts`,
  `lib/access.ts`, `lib/orgs.ts`, `middleware/auth.ts`, the ~93 definer
  functions, and one large migration series.

## 8. Suggested phasing

| Phase | Outcome | Behaviour change for today's single tenant |
|---|---|---|
| 0 | Decisions on the open questions (README) | none |
| 1 | Tenant context plumbing: principal → tenant (`AsyncLocalStorage`); per-request JWT to PostgREST (still `service_role`); jobs carry tenant; no-context gap gate | none (one tenant) |
| 2 | Schema: `tenant_id` + defaults + backfill, composite FKs, tenant-scoped uniques, definer-function audit, canary suite, then forced RLS with the `tenant_app` role and migration gate | none |
| 3 | Storage routing per tenant, tenant-prefixed keys, bound download tokens | none |
| 4 | Multi-tenant identity: identity sources, JIT users, per-tenant roles, tenant-bounded sharing | none |
| 5 | Metering, budgets, reservations, per-tenant model allow-lists, fair queueing | usage visible |
| 6 | Control-plane contract (`cp_*`, usage outbox), regional stamps and tenant routing, and the second real tenant | multi-tenant live |
| 7 | Additional stamps per region, silo tier, sharing portal — when traction justifies | — |

Phases 1–5 can ship to the current single-tenant installs with no visible
change, which lets each one be merged and soaked before a second tenant
exists.
