-- Server-owned browser/Word sessions. Every credential field is AES-GCM
-- ciphertext produced by the backend; only hashes of bearer identifiers are
-- stored. The API reaches these objects through private PostgREST as
-- service_role. No auth.users or Supabase RLS identity is available here.
create table if not exists public.auth_sessions (
  session_hash text primary key,
  provider text not null check (provider in ('entra', 'local', 'supabase')),
  user_id text not null,
  credential_cipher text not null,
  token_expires_at timestamptz not null,
  expires_at timestamptz not null,
  version bigint not null default 0,
  refresh_owner uuid,
  refresh_lease_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_sessions_expiry_idx on public.auth_sessions(expires_at);

create table if not exists public.auth_handoff_tickets (
  ticket_hash text primary key,
  provider text not null check (provider in ('entra', 'local', 'supabase')),
  user_id text not null,
  credential_cipher text not null,
  target_origin text not null,
  request_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_handoff_expiry_idx on public.auth_handoff_tickets(expires_at);

create table if not exists public.auth_oauth_states (
  state_hash text primary key,
  provider text not null,
  browser_nonce_hash text not null,
  code_verifier_cipher text not null,
  return_url text not null,
  target_origin text not null,
  request_id text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_oauth_expiry_idx on public.auth_oauth_states(expires_at);

-- An owner UUID and version fence prevent two refreshes from winning. A
-- revoked session increments version, so an in-flight refresh cannot revive it.
create or replace function public.claim_auth_session_refresh(
  p_session_hash text, p_version bigint, p_owner uuid, p_lease_seconds integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  update public.auth_sessions set
    refresh_owner = p_owner,
    refresh_lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 1), 120))
  where session_hash = p_session_hash and version = p_version
    and revoked_at is null and expires_at > now()
    and (refresh_lease_until is null or refresh_lease_until < now());
  get diagnostics changed = row_count;
  return changed = 1;
end $$;

create or replace function public.finish_auth_session_refresh(
  p_session_hash text, p_version bigint, p_owner uuid,
  p_credential_cipher text, p_token_expires_at timestamptz
) returns boolean language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  update public.auth_sessions set
    credential_cipher = p_credential_cipher,
    token_expires_at = p_token_expires_at,
    version = version + 1,
    refresh_owner = null,
    refresh_lease_until = null
  where session_hash = p_session_hash and version = p_version
    and refresh_owner = p_owner and refresh_lease_until > now()
    and revoked_at is null and expires_at > now();
  get diagnostics changed = row_count;
  return changed = 1;
end $$;

create or replace function public.revoke_auth_session(p_session_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  update public.auth_sessions set
    revoked_at = coalesce(revoked_at, now()),
    version = version + 1,
    refresh_owner = null,
    refresh_lease_until = null
  where session_hash = p_session_hash and revoked_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end $$;

create or replace function public.consume_auth_handoff(
  p_ticket_hash text, p_target_origin text, p_request_id text
) returns setof public.auth_handoff_tickets
language plpgsql security definer set search_path = public as $$
begin
  return query update public.auth_handoff_tickets set consumed_at = now()
  where ticket_hash = p_ticket_hash and target_origin = p_target_origin
    and request_id = p_request_id and consumed_at is null and expires_at > now()
  returning *;
end $$;

create or replace function public.consume_auth_oauth_state(
  p_state_hash text, p_browser_nonce_hash text
) returns setof public.auth_oauth_states
language plpgsql security definer set search_path = public as $$
begin
  return query update public.auth_oauth_states set consumed_at = now()
  where state_hash = p_state_hash and browser_nonce_hash = p_browser_nonce_hash
    and consumed_at is null and expires_at > now()
    and created_at <= now()
  returning *;
end $$;

revoke all on public.auth_sessions, public.auth_handoff_tickets,
  public.auth_oauth_states from public, web_anon, authenticated;
grant select, insert, update, delete on public.auth_sessions,
  public.auth_handoff_tickets, public.auth_oauth_states to service_role;
revoke all on function public.claim_auth_session_refresh(text,bigint,uuid,integer),
  public.finish_auth_session_refresh(text,bigint,uuid,text,timestamptz),
  public.revoke_auth_session(text),
  public.consume_auth_handoff(text,text,text),
  public.consume_auth_oauth_state(text,text) from public, web_anon, authenticated;
grant execute on function public.claim_auth_session_refresh(text,bigint,uuid,integer),
  public.finish_auth_session_refresh(text,bigint,uuid,text,timestamptz),
  public.revoke_auth_session(text),
  public.consume_auth_handoff(text,text,text),
  public.consume_auth_oauth_state(text,text) to service_role;
notify pgrst, 'reload schema';
