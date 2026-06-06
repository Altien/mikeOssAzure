-- 0006_user_api_keys.sql
--
-- Per-user encrypted provider-key storage.
--
-- Originates from upstream commit ba6f7711449de47bd25cad7ac21bdc2a53355963
-- ("Sync security and backend profile updates"), 2026-05-08. Upstream
-- introduced a `user_api_keys` table to move LLM provider keys out of
-- `user_profiles` (where they had been stored in plaintext) into a
-- dedicated table with AES-256-GCM at-rest encryption.
--
-- See `backend/migrations/UPSTREAM_SYNC_LOG.md` for the full decision
-- record. See `the migration tooling/internal notes`
-- for the migration narrative.
--
-- Differences from upstream's shape (for the next-time-this-syncs reader):
--
--   1. No FK to `auth.users`. Upstream uses
--          `user_id uuid not null references auth.users(id) on delete cascade`
--      Dev's Azure Postgres has no `auth.users` schema (no Supabase auth).
--      `user_id` is the Entra `oid` claim, stored directly as a plain
--      uuid. Cascade behaviour is owned by application code.
--      See `TODO(entraid)` headers in `0000_initial.sql`.
--
--   2. No RLS / no Supabase RLS policies. Upstream attaches
--      `enable row level security` + policies using `auth.uid()`.
--      Azure Postgres has no `auth.uid()`. Access control for
--      `user_api_keys` rows is enforced in `backend/src/lib/userApiKeys.ts`
--      at the application layer.
--
--   3. Provider check extended. Upstream supports `claude | gemini`.
--      Dev supports `claude | gemini | openai | azure_openai`. The
--      `azure_openai` row stores a JSON-encoded
--      `{endpoint, key, version, deployment}` object inside
--      `encrypted_key` (the rest of the encryption fields work
--      identically to the other providers).
--
--   4. Encryption secret comes from Azure Key Vault (via the
--      `backend/src/lib/config.ts` pattern: `KEY_VAULT_NAME` +
--      `DefaultAzureCredential` + `SecretClient`). Env-var fallback for
--      local dev only — never as the production path. See
--      `internal design notes` §2.4 (Secrets handling).
--
-- The legacy plaintext columns on `user_profiles` (`claude_api_key`,
-- `gemini_api_key`, `openai_api_key`, `azure_openai_endpoint`,
-- `azure_openai_api_key`, `azure_openai_api_version`,
-- `azure_openai_deployment`) are NOT dropped by this migration. They are
-- emptied by the one-shot encryption script
-- (`backend/scripts/migrate-user-api-keys.ts`) once the encrypted table
-- is populated, then dropped in a follow-up migration after the script
-- has been verified.

create table if not exists public.user_api_keys (
    id uuid primary key default gen_random_uuid(),
    -- TODO(entraid): was upstream `uuid not null references auth.users(id) on delete cascade`.
    -- FK removed; user_id stores the Entra oid claim directly. Application code
    -- owns the cascade-delete behaviour.
    user_id uuid not null,
    -- See header note 3 — dev's provider set is wider than upstream's.
    -- openrouter/courtlistener added with upstream 44e868e; existing
    -- databases get the widened check from 0008 (this CREATE only fires
    -- on fresh installs).
    provider text not null check (
        provider in (
            'claude', 'gemini', 'openai', 'openrouter', 'courtlistener',
            'azure_openai'
        )
    ),
    -- Base64-encoded AES-256-GCM ciphertext. For `azure_openai` rows the
    -- plaintext is a JSON-encoded `{endpoint, key, version, deployment}`
    -- object; for other providers the plaintext is the raw key string.
    encrypted_key text not null,
    -- Base64-encoded 12-byte random IV (one per row).
    iv text not null,
    -- Base64-encoded 16-byte GCM authentication tag.
    auth_tag text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, provider)
);

create index if not exists idx_user_api_keys_user
    on public.user_api_keys(user_id);

-- RLS deliberately not enabled — see header note 2.
