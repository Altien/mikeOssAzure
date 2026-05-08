# 003 — Schema migrations

**Status:** Accepted

## Context

The repository contains exactly one migration file, `backend/migrations/000_one_shot_schema.sql` (341 lines), and no migration runner. There is no `schema_migrations` table, no version tracking, no Supabase CLI workflow checked in. New columns, indexes, and the EntraID-related changes coming in the next phase need a tool to apply them reliably.

The team owns a Node/TypeScript backend; introducing a JVM tool (Flyway, Liquibase) for schema management would expand the supported runtime surface. Running raw `psql` in CI works for the first migration but reinvents version tracking, locking, and partial-failure recovery as the count grows.

## Decision

**Use [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) as the schema migration tool.** Run it as a one-shot **Azure Container Apps Job** that reuses the backend's container image and Managed Identity.

### Repo layout

```
backend/
├── migrations/
│   ├── 0000_initial.sql      # ports 000_one_shot_schema.sql verbatim, with TODO(entraid) markers
│   ├── 0001_<change>.sql     # new migrations from here on
│   └── ...
├── package.json              # adds: "node-pg-migrate" devDependency, "migrate" script
└── ...
```

`package.json` script:

```json
"migrate": "node-pg-migrate up --migrations-dir migrations --migration-file-language sql"
```

### How it runs in Azure

A `Microsoft.App/jobs` resource named `db-migrate`:

- **Image:** the same `<your-acr>.azurecr.io/backend:<sha>` used by the backend Container App.
- **Command:** `npm run migrate`.
- **Trigger:** Manual (`az containerapp job start -n db-migrate`); invoked by the deploy pipeline after the new image is published and before the backend Container App revision is promoted.
- **Identity:** system-assigned MI, granted `Key Vault Secrets User` on the vault — same pattern as the backend.
- **Connection target:** Postgres directly (port 5432), not via PgBouncer, because some DDL (`CREATE EXTENSION`, prepared-statement-style migrations) misbehaves under transaction-mode pooling.

### Why a Job, not the backend itself

Running migrations on backend startup is tempting and wrong. With multiple replicas, multiple instances race; with a failed migration, every replica crash-loops; with a long migration, the readiness probe fails. A dedicated single-replica job is the boring correct primitive.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. `node-pg-migrate` as a Container Apps Job** *(chosen)* | Same language and repo as the backend. Container Apps Jobs is the right primitive for one-shot work. Secrets via the existing MI/KV path. | Adds one Bicep resource and one dev dependency. |
| **B. Plain SQL files + `psql` in CI** | Zero new dependencies. Trivial mental model. | No version tracking out of the box — must be hand-rolled. Locking, transactions-per-migration, and rollback all become bespoke. CI needs DB credentials. |
| **C. Flyway / Liquibase / Sqitch** | Battle-tested. Strong dry-run and repair stories. | JVM (Flyway/Liquibase) or Perl (Sqitch) dependency in the build pipeline. Overkill for a 10-table schema. Customers self-deploying do not want a JVM. |
| **D. Drizzle Kit / Prisma Migrate** | Schema-as-code, type-safe migration generation. | Source of truth for queries today is `@supabase/supabase-js` builders, not a Drizzle/Prisma schema. Introducing a parallel ORM-shaped schema definition adds a second source of truth. |

## Consequences

- **`backend/migrations/0000_initial.sql` carries `TODO(entraid):` markers.** The current schema's `references auth.users(id) on delete cascade` and `on_auth_user_created` trigger cannot run on Azure Postgres as-is. They are commented out (or deleted) in the initial migration; the EntraID agent owns the replacement.
- **Migrations run before the backend revision is promoted.** The deploy pipeline:
  1. Builds and pushes the new image.
  2. Calls `az containerapp job start -n db-migrate`, waits for completion.
  3. Updates the backend Container App with the new image.

  Failed migrations block the deploy. The previous backend revision keeps running.
- **Migration files are append-only.** Existing files are never edited after they reach `main`. Corrections are forward-only migrations.
- **Customer deploys run the same job.** The customer's deploy pipeline calls the same `az containerapp job start` step. They do not need any new tooling on their side; everything ships in the image.
- **No automatic rollback.** `node-pg-migrate` supports `down` migrations, but in practice we treat database changes as forward-only. Rollback in production is a new migration that undoes the change, not a `down`.
- **Local development.** Engineers run `npm run migrate` against a local Postgres (Docker Compose), same script as production. No environment drift between local and Azure.

## Deferred to the EntraID work

- The contents of `0000_initial.sql` need surgery (FK and trigger removal) and at least one new migration to introduce whatever EntraID-shaped columns or tables are needed.
- The MI on the migration job will eventually authenticate to Postgres via EntraID rather than a SQL password from Key Vault.
