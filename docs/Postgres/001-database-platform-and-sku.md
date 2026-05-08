# 001 — Database platform and SKU

**Status:** Accepted

## Context

Azure offers three managed Postgres products:

- **Azure Database for PostgreSQL — Flexible Server.** General-purpose managed Postgres. Single-server topology with optional zone-redundant HA. Supports `pgcrypto`, vacuum tuning, connection pooling via built-in PgBouncer.
- **Azure Cosmos DB for PostgreSQL.** Distributed Postgres (formerly Hyperscale / Citus). Horizontal sharding for very large or multi-tenant workloads.
- **Azure Database for PostgreSQL — Single Server.** Deprecated; not a candidate.

The application is single-tenant from the database's perspective (multi-user, but ~10 tables, no sharding requirement), with modest write volume and no analytical workload.

## Decision

**Azure Database for PostgreSQL — Flexible Server**, Postgres 16.

SKU sizing:

| Environment | SKU | vCPU / RAM | Approx $/mo | Notes |
|---|---|---|---|---|
| Dev | `Standard_B1ms` (Burstable) | 1 / 2 GiB | $12–15 | Stoppable for up to 30 days; storage charges only when stopped. |
| Prod (initial) | `Standard_B2s` (Burstable) | 2 / 4 GiB | $25–30 | Stoppable. No HA, no read replicas at this tier. |
| Prod (when justified) | `Standard_D2s_v5` (General Purpose) | 2 / 8 GiB | ~$140 | Always-on. Supports zone-redundant HA, read replicas, predictable performance. |

Storage starts at **32 GiB** with autogrow disabled; resize online when needed.

Backup retention: **7 days dev, 35 days prod** (the maximum on Burstable). Geo-redundant backups off.

Built-in **PgBouncer enabled**: transaction mode by default. The backend connects in transaction mode; PostgREST connects in session mode (it relies on session-scoped settings for JWT claim propagation).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. Flexible Server, Burstable → upgrade path** *(chosen)* | Cheapest viable starting point. Stoppable in non-prod. SKU change is online. | No HA on Burstable. |
| **B. Flexible Server, General Purpose from day one** | HA available immediately. Predictable performance. | ~5–10× the cost. Cannot be stopped. Premature for current load. |
| **C. Cosmos DB for PostgreSQL** | Distributed, scales horizontally. | Wrong shape for a 10-table single-tenant schema. ~5× the cost of Flexible Server. Operational overhead of a distributed coordinator. |

## Consequences

- **No HA in production initially.** A zone outage in our region takes the database down. Acceptable at the current stage; revisit when a written SLA exists. Daily PITR backups still cover loss-of-data scenarios.
- **Burstable can be stopped.** Used aggressively in dev and ephemeral preview environments. The Bicep template does not stop servers automatically; that is an operator action (or a scheduled CI workflow if/when we automate it).
- **Tier upgrades are online but not instant.** Burstable → General Purpose takes a few minutes of degraded performance, not a maintenance window. Plan upgrades for low-traffic periods.
- **PgBouncer is the default connection target.** Connection strings the backend receives terminate at port 6432 (PgBouncer), not 5432 (Postgres directly). Some operational tasks (`CREATE DATABASE`, `ALTER ROLE`, prepared statements outside transactions) require a direct connection — for those, point `psql` at port 5432.
- **`pgcrypto` is the only required extension** today and is available on Flexible Server out of the box; the initial migration enables it. Future extensions (e.g. `pgvector` if we ever embed) are also available — verify on the [Azure-supported extensions list](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-extensions) before depending on one.
- **Region selection** is a Bicep parameter; defaults to `westeurope`. Customer deploys override.

## Deferred to the EntraID work

- Whether the **admin user** is a SQL login or an EntraID identity. SKU choice is independent of the auth model. The default Bicep provisions a SQL admin (`mikeadmin`) with a password in Key Vault; the EntraID agent replaces this.
- Whether **read replicas** are required for read-heavy auth-coupled workloads (e.g. session lookups). Defer until measurement; replicas require General Purpose anyway.
