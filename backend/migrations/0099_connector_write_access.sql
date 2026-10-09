-- Azure private PostgREST adaptation of upstream #566 (2ec7cfc1):
--   20261001_01_connector_write_access.sql, 20261002_01_google_drive_writes.sql,
--   20261002_02_google_drive_account_email.sql, 20261002_03_connector_read_only.sql,
--   20261002_05_mcp_oauth_grants.sql.
-- 20261002_04_remove_user_time_zone.sql is not ported: Dev never added
-- user_profiles.time_zone.
--
-- Connector settings (on/off, per-tool switches, read-only, approval for write
-- actions), in-chat approvals replacing the out-of-turn Google proposal table,
-- Google Drive OAuth states merged into google_workspace_oauth_states, and a
-- stable MCP OAuth grant identity for approval bindings.
--
-- Dev divergences (sync-log: 2ec7cfc1) — keep them during future syncs:
--   * Upstream re-enables every MCP tool that discovery had force-disabled
--     (`update user_mcp_connector_tools set enabled = true where
--     requires_confirmation and not enabled`). Dev does NOT: it cannot tell a
--     forced disable from the user's own choice, so every disabled tool stays
--     disabled until the owner turns it on in Settings → Connectors.
--   * Upstream defaults require_write_approval to false. Dev defaults it to
--     true on every connector table and backfills existing rows to true, so
--     writes that previously needed human confirmation (MCP) or an approved
--     proposal (Gmail/Calendar) still need approval until the owner changes it.
--   * A Gmail/Calendar grant made with writes opted out (write_enabled=false)
--     becomes read_only=true when the column is first added, so a later
--     reconnect with broader scopes cannot silently grant write authority.
--   * Recoverable data is not dropped in the same migration as its
--     replacement: google_drive_oauth_states and google_workspace_actions are
--     retained (no longer written). Pending proposals are settled as rejected;
--     only the obsolete claim function is removed. A later numbered
--     migration drops the two tables after the switch is verified.
--   * Text actor IDs and transaction-scoped advisory locks replace upstream's
--     auth.users row locks; no Supabase auth schema or RLS.
-- Idempotent: safe to re-run.

-- MCP connectors ------------------------------------------------------------
alter table public.user_mcp_connectors
  add column if not exists require_write_approval boolean not null default true,
  add column if not exists read_only boolean not null default false;
alter table public.user_mcp_connectors
  alter column require_write_approval set default true;

alter table public.user_mcp_oauth_tokens
  add column if not exists grant_id uuid not null default gen_random_uuid();

-- Google Drive ---------------------------------------------------------------
alter table public.user_google_drive_tokens
  add column if not exists enabled boolean not null default true,
  add column if not exists disabled_tools text[] not null default '{}',
  add column if not exists grant_id uuid not null default gen_random_uuid(),
  add column if not exists require_write_approval boolean not null default true,
  add column if not exists read_only boolean not null default false,
  add column if not exists account_email text;
alter table public.user_google_drive_tokens
  alter column require_write_approval set default true;

-- Gmail / Calendar -----------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_google_workspace_tokens'
      and column_name = 'read_only'
  ) then
    alter table public.user_google_workspace_tokens
      add column read_only boolean not null default false;
    -- Preserve an explicit write opt-out; runs once, when the column appears.
    update public.user_google_workspace_tokens
      set read_only = true
      where write_enabled is distinct from true;
  end if;
end;
$$;
alter table public.user_google_workspace_tokens
  add column if not exists enabled boolean not null default true,
  add column if not exists require_write_approval boolean not null default true,
  add column if not exists disabled_tools text[] not null default '{}';
alter table public.user_google_workspace_tokens
  alter column require_write_approval set default true;

-- One OAuth state table for every Google connection --------------------------
alter table public.google_workspace_oauth_states
  drop constraint if exists google_workspace_oauth_states_provider_check;
alter table public.google_workspace_oauth_states
  add constraint google_workspace_oauth_states_provider_check
  check (provider in ('gmail', 'google-calendar', 'google-drive'));

-- Keep Drive sign-ins that are in flight while this runs (ids, hashes,
-- encrypted configs and expiry preserved). The old table is retained.
do $$
begin
  if to_regclass('public.google_drive_oauth_states') is not null then
    insert into public.google_workspace_oauth_states (
      id, user_id, provider, state_hash,
      encrypted_state_config, state_config_iv, state_config_tag, expires_at
    )
    select id, user_id, 'google-drive', state_hash,
      encrypted_state_config, state_config_iv, state_config_tag, expires_at
    from public.google_drive_oauth_states
    where expires_at > now()
    on conflict do nothing;
  end if;
end;
$$;

-- Reconnecting replaces the grant (new grant_id) but keeps the user's
-- connector settings. Write capability is what Google actually granted.
create or replace function public.complete_google_workspace_oauth(p_state_hash text, p_provider text, p_tokens jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_state public.google_workspace_oauth_states;
begin
  if p_provider not in ('gmail', 'google-calendar') then return false; end if;
  select * into v_state from public.google_workspace_oauth_states where state_hash = p_state_hash and provider = p_provider;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-workspace:' || v_state.user_id, 0));
  delete from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = p_provider and user_id = v_state.user_id and expires_at > now()
    returning * into v_state;
  if not found then return false; end if;
  insert into public.user_google_workspace_tokens(user_id, provider, account_email, account_id, encrypted_access_token, access_token_iv, access_token_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at, write_enabled)
  values (v_state.user_id, p_provider, p_tokens->>'account_email', p_tokens->>'account_id', p_tokens->>'encrypted_access_token', p_tokens->>'access_token_iv', p_tokens->>'access_token_tag', p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv', p_tokens->>'refresh_token_tag', p_tokens->>'scope', (p_tokens->>'expires_at')::timestamptz, coalesce((p_tokens->>'write_enabled')::boolean, false))
  on conflict (user_id, provider) do update set
    grant_id = gen_random_uuid(), account_email = excluded.account_email, account_id = excluded.account_id, encrypted_access_token = excluded.encrypted_access_token,
    access_token_iv = excluded.access_token_iv, access_token_tag = excluded.access_token_tag,
    encrypted_refresh_token = excluded.encrypted_refresh_token, refresh_token_iv = excluded.refresh_token_iv, refresh_token_tag = excluded.refresh_token_tag,
    scope = excluded.scope, expires_at = excluded.expires_at, write_enabled = excluded.write_enabled;
  return true;
end;
$$;

create or replace function public.disconnect_google_workspace(p_user_id text, p_provider text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-workspace:' || p_user_id, 0));
  delete from public.google_workspace_oauth_states where user_id = p_user_id and provider = p_provider;
  delete from public.user_google_workspace_tokens where user_id = p_user_id and provider = p_provider;
end;
$$;

revoke all on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(text,text) from public, web_anon, authenticated;
grant execute on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(text,text) to service_role;

-- The one definition of Drive completion for this change: consumes the merged
-- state table in the same transaction as the token write, rotates grant_id on
-- reconnect, records the verified account email and keeps settings.
create or replace function public.complete_google_drive_oauth(p_state_hash text, p_tokens jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id text;
  v_consumed text;
begin
  select user_id into v_user_id from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = 'google-drive';
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-drive:' || v_user_id, 0));
  delete from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = 'google-drive'
      and user_id = v_user_id and expires_at > now()
    returning user_id into v_consumed;
  if not found then return false; end if;
  insert into public.user_google_drive_tokens (
    user_id, account_email, encrypted_access_token, access_token_iv, access_token_tag,
    encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at
  ) values (
    v_user_id, p_tokens->>'account_email', p_tokens->>'encrypted_access_token',
    p_tokens->>'access_token_iv', p_tokens->>'access_token_tag',
    p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv',
    p_tokens->>'refresh_token_tag', p_tokens->>'scope',
    (p_tokens->>'expires_at')::timestamptz
  ) on conflict (user_id) do update set
    grant_id = gen_random_uuid(),
    account_email = excluded.account_email,
    encrypted_access_token = excluded.encrypted_access_token,
    access_token_iv = excluded.access_token_iv, access_token_tag = excluded.access_token_tag,
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    refresh_token_iv = excluded.refresh_token_iv, refresh_token_tag = excluded.refresh_token_tag,
    scope = excluded.scope, expires_at = excluded.expires_at, updated_at = now();
  return true;
end;
$$;
revoke all on function public.complete_google_drive_oauth(text, jsonb) from public, web_anon, authenticated;
grant execute on function public.complete_google_drive_oauth(text, jsonb) to service_role;

create or replace function public.disconnect_google_drive(p_user_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-drive:' || p_user_id, 0));
  delete from public.google_workspace_oauth_states
    where user_id = p_user_id and provider = 'google-drive';
  -- The retained pre-merge table: clear it too while it exists.
  if pg_catalog.to_regclass('public.google_drive_oauth_states') is not null then
    execute 'delete from public.google_drive_oauth_states where user_id = $1' using p_user_id;
  end if;
  delete from public.user_google_drive_tokens where user_id = p_user_id
    returning to_jsonb(user_google_drive_tokens) into v_token;
  return v_token;
end;
$$;
revoke all on function public.disconnect_google_drive(text) from public, web_anon, authenticated;
grant execute on function public.disconnect_google_drive(text) to service_role;

-- Retire the out-of-turn proposal system. Pending proposals receive a recorded
-- terminal outcome; executing/uncertain rows are left exactly as they are and
-- are never turned into new pending writes. Only the claim function goes now.
do $$
begin
  if to_regclass('public.google_workspace_actions') is not null then
    update public.google_workspace_actions
      set status = 'rejected',
          result_message = 'Superseded by in-chat approvals. Ask the assistant again to review a fresh action.'
      where status = 'pending';
  end if;
end;
$$;
drop function if exists public.claim_google_workspace_action(text, uuid);
