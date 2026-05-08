## Parent docs

`docs/Postgres/003-schema-migrations.md`
`docs/Postgres/004-entraid-handoff.md`

## What to build

Replace the single Supabase-specific `backend/migrations/000_one_shot_schema.sql` with a versioned migration system using `node-pg-migrate`, and port the schema into a form that runs cleanly on Azure Postgres (no `auth` schema references).

### node-pg-migrate setup

Add to `backend/package.json`:
```json
"node-pg-migrate": "^7.x"
```
Add script:
```json
"migrate": "node-pg-migrate up --migrations-dir migrations --migration-file-language sql"
```
Add `"migrate:down": "node-pg-migrate down ..."` for local use only; production is forward-only.

### Initial migration: `backend/migrations/0000_initial.sql`

Port `backend/migrations/000_one_shot_schema.sql` verbatim with these Supabase-specific items removed/replaced:

1. **`references auth.users(id) on delete cascade`** on `user_profiles.user_id` — remove FK. Column stays as `uuid not null unique`. Application code owns cascade behaviour.
2. **RLS policies** (`auth.uid() = user_id`) on `user_profiles` — remove `alter table ... enable row level security` and both `create policy` statements. Authorization is enforced at `backend/src/lib/access.ts`. Document this as a `TODO(entraid): re-evaluate RLS if PostgREST is ever exposed to untrusted clients`.
3. **`handle_new_user()` trigger and `on_auth_user_created` trigger** — remove both. Profile creation moves to application code (`011-user-bootstrap-profile-endpoints.md`). Add a `TODO(entraid): trigger removed; see upsertUserProfile in backend`.
4. **`pgcrypto` extension** — keep; it is supported on Azure Postgres Flexible Server.

Everything else in the schema (all tables, indexes, constraints) is preserved verbatim.

### Migration runner job

Add `infra/modules/containerapp-job-migrate.bicep`:
- `Microsoft.App/jobs`, `triggerType: Manual`, `replicaTimeout: 600`, `replicaRetryLimit: 1`.
- Image: same `backendImage` parameter as the backend Container App.
- Command: `["npm", "run", "migrate"]`.
- System-assigned Managed Identity; `Key Vault Secrets User` on the vault.
- Connects directly to Postgres port 5432 (not PgBouncer) via `DATABASE_URL` env var sourced from Key Vault.
- Does **not** have external ingress.

Deploy pipeline order: build image → push to ACR → `az containerapp job start -n db-migrate` (wait for success) → promote backend Container App revision.

## Acceptance criteria

- [ ] `npm run migrate` (against a local Postgres or Azurite-equivalent) completes without errors.
- [ ] `node_modules/.bin/node-pg-migrate` version is pinned in `package-lock.json`.
- [ ] `backend/migrations/0000_initial.sql` contains no references to `auth.users`, `auth.uid()`, or `on_auth_user_created`.
- [ ] All tables from the original schema exist after migration; row counts and constraints match (verified by a smoke-test query list).
- [ ] `az containerapp job start -n db-migrate` succeeds against the provisioned Azure Postgres (from slice 003); job exits 0.
- [ ] A second run of `npm run migrate` is idempotent (no error, no duplicate objects).
- [ ] `TODO(entraid):` markers are present at each removed Supabase coupling point.

## Blocked by

- `003-postgres-provisioning.md` (Azure Postgres must exist to run the migration job end-to-end)

## User stories addressed

- Schema changes are version-tracked and applied atomically.
- A failed migration blocks the deploy without taking down the running backend revision.
- Local dev and Azure use the same migration script with no environment drift.
