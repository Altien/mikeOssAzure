# Postgres migration decisions

This folder captures decisions specific to moving the database off Supabase and onto **Azure Database for PostgreSQL Flexible Server**. Infrastructure decisions that surround the database (networking, compute, secrets) live in `../infra/`.

These docs are written ADR-style: each one states the decision, the options considered, what we chose, and why. Read them in order; they reference each other.

## What's actually in scope

The Supabase audit (run before these decisions were made) found the following Supabase-specific surface area in the application:

| Supabase feature | Used? | Migration impact |
|---|---|---|
| PostgREST query API (`@supabase/supabase-js` `.from()`) | **Yes — 246 callsites** | Self-host PostgREST. See `002-postgrest-and-access-pattern.md`. |
| `auth.users` foreign key on `user_profiles` | **Yes** | **Deferred to EntraID work.** See `004-entraid-handoff.md`. |
| `auth.uid()` in RLS policies on `user_profiles` | **Yes (2 policies)** | **Deferred to EntraID work**, and will likely be removed entirely — see `002-postgrest-and-access-pattern.md`. |
| `on_auth_user_created` trigger | **Yes** | **Deferred to EntraID work.** Replaced by application-side profile creation. |
| Realtime subscriptions | No | No migration needed. |
| Supabase Storage | No (already on R2) | No migration needed. |
| Edge Functions | No | No migration needed. |
| `supabase.rpc()` calls | No | No migration needed. |
| `pgcrypto` extension | Yes | Available on Flexible Server; enabled in initial migration. |
| Supabase Studio (web admin UI) | Yes (operational) | Replaced by Azure Portal + `psql` via `az containerapp exec` + (optional) pgAdmin via Bastion. |

## Index

| # | Title | Summary |
|---|---|---|
| 001 | [Database platform and SKU](001-database-platform-and-sku.md) | Flexible Server, Burstable B1ms (dev) / B2s (prod), upgrade path to General Purpose |
| 002 | [PostgREST and access pattern](002-postgrest-and-access-pattern.md) | Self-host PostgREST internally; refactor 9 frontend callsites so the browser never talks to the DB |
| 003 | [Schema migrations](003-schema-migrations.md) | `node-pg-migrate` run as a Container Apps Job on each deploy |
| 004 | [EntraID hand-off](004-entraid-handoff.md) | Explicit list of items the EntraID agent must own |

## Settled checklist

| Concern | Resolution |
|---|---|
| Database engine and version | Postgres 16 on Flexible Server |
| SKU baseline | B1ms (dev), B2s (prod), upgrade to D2s_v5 when justified |
| HA (zone-redundant) | Not enabled initially; revisit when downtime has revenue cost |
| Backup retention | 7 days (dev), 35 days (prod) |
| Geo-redundant backups | Off |
| Public network access | **Disabled** in all environments; Private Endpoint only |
| Connection pooling | Built-in PgBouncer enabled, transaction mode for backend, session mode for PostgREST |
| Schema migration tool | `node-pg-migrate`, run as a Container Apps Job |
| Data access from browser | **Removed** — all DB traffic goes through the Express backend |
| `@supabase/supabase-js` in backend | Kept; points at internal PostgREST URL |

## Open items (deferred to the EntraID agent)

See `004-entraid-handoff.md` for the full list. Headlines:

1. Strip the `auth.users` FK on `user_profiles`; decide what `user_id` actually is (EntraID OID? subject claim?).
2. Replace the `handle_new_user()` trigger with profile creation in the EntraID sign-in callback.
3. Decide RLS strategy now that the browser does not talk to PostgREST (recommendation: leave RLS off, rely on backend authorization).
4. Decide Postgres admin auth: SQL password in Key Vault vs Container App MI granted EntraID auth on the database.
5. Plan the data cutover runbook: Supabase user ID → EntraID OID mapping, export/import flow, downtime window.
