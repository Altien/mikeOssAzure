-- 0011_mcp_connector_oauth.sql
--
-- OAuth metadata/state for HTTP MCP connectors that authorize via OAuth 2.x
-- instead of pasted bearer tokens.
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260615_01_mcp_connector_oauth.sql` (commit
-- 9a1277ba99cbd7dfae77e5b882e5cef8521fca2f). See header of
-- 0010_user_mcp_connectors.sql for the divergence rationale (no auth.users
-- FK, no RLS / Supabase grants — access scoped in
-- backend/src/lib/mcp/oauth.ts; OAuth state config is AES-256-GCM encrypted
-- with a Key-Vault-resolved key).
--
-- Idempotent: safe to re-run.

alter table public.user_mcp_connectors
    add column if not exists auth_type text not null default 'none'
        check (auth_type in ('none', 'bearer', 'oauth'));

update public.user_mcp_connectors
set auth_type = case
    when encrypted_auth_config is not null then 'bearer'
    else 'none'
end
where auth_type is null or auth_type = 'none';

alter table public.user_mcp_oauth_tokens
    add column if not exists authorization_server text,
    add column if not exists token_endpoint text,
    add column if not exists client_id text,
    add column if not exists encrypted_client_secret text,
    add column if not exists client_secret_iv text,
    add column if not exists client_secret_tag text,
    add column if not exists resource text;

create table if not exists public.user_mcp_oauth_states (
    id uuid primary key default gen_random_uuid(),
    -- TODO(entraid): upstream had `uuid not null references auth.users(id)
    -- on delete cascade`; plain text Entra oid here.
    user_id text not null,
    connector_id uuid not null
        references public.user_mcp_connectors(id) on delete cascade,
    state_hash text not null unique,
    encrypted_state_config text not null,
    state_config_iv text not null,
    state_config_tag text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_oauth_states_expires
    on public.user_mcp_oauth_states(expires_at);

-- RLS and anon/authenticated grants deliberately omitted — see 0010 header.
