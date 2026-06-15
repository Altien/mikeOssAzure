-- 0010_user_mcp_connectors.sql
--
-- Server-side MCP (Model Context Protocol) client connector storage.
--
-- Originates from upstream commit 9a1277ba99cbd7dfae77e5b882e5cef8521fca2f
-- ("refactor: add table primitive and migrations by date; feat: add mcp
-- connectors"), re-authored in dev's numbered-migration style from upstream's
-- date-based `backend/migrations/20260613_04_user_mcp_connectors.sql`. See
-- `backend/migrations/UPSTREAM_SYNC_LOG.md` and
-- `the migration tooling/internal notes`.
--
-- Connector auth material (bearer tokens / custom headers) is encrypted by the
-- backend (AES-256-GCM) before insert; the encryption key is resolved from
-- Azure Key Vault (internal design notes §2.4) in `backend/src/lib/mcp/client.ts`.
--
-- Differences from upstream's shape (for the next-time-this-syncs reader):
--
--   1. No FK to `auth.users`. Upstream uses
--          `user_id uuid not null references auth.users(id) on delete cascade`
--      Dev's Azure Postgres has no `auth.users` schema (no Supabase auth).
--      `user_id` is the Entra `oid` claim, stored as a plain text column to
--      match every other dev table (projects/chats/workflows.user_id are all
--      `text`). Cascade-by-user is owned by application code
--      (`backend/src/lib/userDataCleanup.ts`).
--
--   2. No RLS / no Supabase grants. Upstream attaches
--      `enable row level security` and `revoke ... from anon, authenticated`.
--      Azure Postgres has no anon/authenticated PostgREST roles and dev
--      enforces access in `backend/src/lib/mcp/servers.ts` at the
--      application layer (every query is scoped by `user_id`). The
--      cross-table FKs to dev-owned tables (user_mcp_connectors etc.) are
--      kept — only the `auth.users` FK is the Supabase-only bit that's
--      dropped.
--
-- Idempotent: safe to re-run.

create table if not exists public.user_mcp_connectors (
    id uuid primary key default gen_random_uuid(),
    -- TODO(entraid): upstream had `uuid not null references auth.users(id)
    -- on delete cascade`. FK removed; user_id stores the Entra oid claim
    -- directly as text. Application code owns cascade-delete behaviour.
    user_id text not null,
    name text not null,
    transport text not null default 'streamable_http'
        check (transport in ('streamable_http')),
    server_url text not null,
    enabled boolean not null default true,
    tool_policy jsonb not null default '{}'::jsonb,
    encrypted_auth_config text,
    auth_config_iv text,
    auth_config_tag text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_connectors_user
    on public.user_mcp_connectors(user_id);

create table if not exists public.user_mcp_oauth_tokens (
    id uuid primary key default gen_random_uuid(),
    connector_id uuid not null
        references public.user_mcp_connectors(id) on delete cascade,
    encrypted_access_token text,
    access_token_iv text,
    access_token_tag text,
    encrypted_refresh_token text,
    refresh_token_iv text,
    refresh_token_tag text,
    token_type text,
    scope text,
    expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (connector_id)
);

create table if not exists public.user_mcp_connector_tools (
    id uuid primary key default gen_random_uuid(),
    connector_id uuid not null
        references public.user_mcp_connectors(id) on delete cascade,
    tool_name text not null,
    openai_tool_name text not null,
    title text,
    description text,
    input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
    output_schema jsonb,
    annotations jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    requires_confirmation boolean not null default false,
    last_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (connector_id, tool_name),
    unique (openai_tool_name)
);

create index if not exists idx_user_mcp_connector_tools_connector
    on public.user_mcp_connector_tools(connector_id);

create table if not exists public.user_mcp_tool_audit_logs (
    id uuid primary key default gen_random_uuid(),
    -- TODO(entraid): upstream had `uuid not null references auth.users(id)`;
    -- plain text Entra oid here (see user_mcp_connectors note 1).
    user_id text not null,
    connector_id uuid not null
        references public.user_mcp_connectors(id) on delete cascade,
    tool_id uuid
        references public.user_mcp_connector_tools(id) on delete set null,
    tool_name text not null,
    openai_tool_name text not null,
    status text not null check (status in ('ok', 'error')),
    error_message text,
    duration_ms integer not null default 0,
    result_size_chars integer not null default 0,
    created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_audit_logs_user_created
    on public.user_mcp_tool_audit_logs(user_id, created_at desc);

-- RLS and anon/authenticated grants deliberately omitted — see header note 2.
