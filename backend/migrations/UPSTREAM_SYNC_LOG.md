# Upstream sync log

A running record of every upstream commit that affects dev's schema, with
the per-decision reasoning. Future syncs append entries here so we can
reconstruct *why* dev's migrations look the way they do.

This is dev's complement to `MikeMigrate/notes/upstream-sync/*.md`. The
notes file records the full per-migration narrative (cherry-pick state,
conflicts, application changes); this log is the schema-side index.

Read order: newest entry on top.

---

## 2026-05-08 — upstream `ba6f7711449de47bd25cad7ac21bdc2a53355963`

**Subject:** "Sync security and backend profile updates"

**Schema changes upstream made (in upstream's `backend/schema.sql`):**

1. Removed two columns from `user_profiles`:
   - `claude_api_key text`
   - `gemini_api_key text`
2. Added new table `user_api_keys` with AES-GCM at-rest encryption
   (`encrypted_key, iv, auth_tag`), provider check (`claude | gemini`),
   `unique(user_id, provider)`.
3. ~600 lines of Supabase RLS policies and `auth.uid()`/`auth.jwt()`
   helper functions covering most public tables.

**Decisions for dev:**

| Item | Decision | Rationale |
|---|---|---|
| Upstream's `backend/schema.sql` file | **REJECTED** | Dev uses numbered migrations as the source of truth (see `MIGRATION_KNOWLEDGE.md` §2.2). Never import upstream's schema.sql — it would drift from the numbered migrations. |
| New `user_api_keys` table | **APPLIED** (with adaptation) — see `0006_user_api_keys.sql`. | Encryption-at-rest for provider keys is a clear security win. Dev's adaptation: no `auth.users` FK, no RLS (access control in app layer), provider check extended to dev's 4-provider set (`claude | gemini | openai | azure_openai`); `azure_openai` rows store a JSON-encoded compound shape inside `encrypted_key`. |
| Removal of `claude_api_key, gemini_api_key` from `user_profiles` | **DEFERRED** to a follow-up migration after the one-shot data move | Dev has user data in these columns (and also `openai_api_key` and the four `azure_openai_*` columns added in `0003`). They get emptied by `backend/scripts/migrate-user-api-keys.ts` (run after this migration), and dropped by a `0007_drop_legacy_provider_keys.sql` only after the script has been verified. |
| RLS policies + `auth.uid()`/`auth.jwt()` helpers | **NOT APPLICABLE** | Azure Postgres has no `auth.uid()`. Equivalent intent (per-user/per-share access scoping) is enforced in `backend/src/lib/access.ts` at the application layer. Existing dev migrations (`0000_initial.sql`'s `TODO(entraid)` headers, `0005_postgres_roles.sql`) already document this divergence. |

**Application changes that accompany the schema work** (separate commits
on the migration branch `upstream-sync/mikeOssOrig-ba6f771`):

- `backend/src/lib/userApiKeys.ts` — encryption library (Key Vault
  primary, env-var fallback for local dev only; AES-256-GCM; supports
  all 4 providers; serialises Azure OpenAI's compound shape).
- `backend/scripts/migrate-user-api-keys.ts` — one-shot script that
  reads every user's plaintext provider keys, encrypts them, inserts
  rows into `user_api_keys`, and `UPDATE`s the legacy columns to
  `NULL`. Idempotent — re-running sees no rows to migrate. Wired as
  `npm run migrate:user-api-keys`.
- Refactor of `backend/src/lib/userSettings.ts`, `backend/src/routes/user.ts`,
  `backend/src/routes/diagnostics.ts` to read provider keys via
  `userApiKeys.getApiKey(...)` instead of selecting plaintext columns.
  `routes/user.ts` no longer returns plaintext keys to the client —
  it returns `{configured: bool}` per provider (security improvement
  beyond upstream's scope).
- helmet + per-route rate limiters in `backend/src/index.ts`
  (taken from upstream's same commit — applied in a separate logical
  commit on this branch).

**Process to drop the legacy plaintext columns (separate, later commit):**

1. Ensure `0006_user_api_keys.sql` has been applied in every
   environment.
2. Run `npm run migrate:user-api-keys` in each environment until it
   reports zero rows remaining.
3. Land `0007_drop_legacy_provider_keys.sql`:
   - `alter table public.user_profiles drop column if exists claude_api_key, drop column if exists gemini_api_key, drop column if exists openai_api_key, drop column if exists azure_openai_endpoint, drop column if exists azure_openai_api_key, drop column if exists azure_openai_api_version, drop column if exists azure_openai_deployment;`
4. Audit `git grep` for any remaining references to those column
   names before merging step 3.
