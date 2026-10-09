-- Dev adaptation of upstream 54e66261: cross-replica ownership for server runs.
-- Only routing metadata belongs in PostgreSQL. SSE frames and Word tool
-- arguments/results remain in the owning process and encrypted relay.
create sequence if not exists public.stream_run_fence_seq;

create table if not exists public.stream_run_nodes (
  instance_id uuid primary key,
  public_key text not null,
  expires_at timestamptz not null
);

create table if not exists public.stream_runs (
  id uuid primary key,
  run_key text not null,
  surface text not null check (surface in ('chat', 'tabular', 'word', 'review')),
  user_id text not null,
  meta jsonb not null default '{}'::jsonb,
  owner_instance uuid not null references public.stream_run_nodes(instance_id),
  owner_token uuid not null,
  fence bigint not null default nextval('public.stream_run_fence_seq'),
  state text not null check (state in ('running', 'stopping', 'finished', 'owner_lost')),
  seq bigint not null default 0,
  started_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz not null,
  lifetime_expires_at timestamptz not null,
  stop_deadline_at timestamptz,
  finished_at timestamptz,
  retention_expires_at timestamptz,
  terminal_reason text
);
create unique index if not exists stream_runs_live_key
  on public.stream_runs(run_key) where state in ('running', 'stopping');
create index if not exists stream_runs_expiry
  on public.stream_runs(lease_expires_at, lifetime_expires_at)
  where state in ('running', 'stopping');
create index if not exists stream_runs_retention
  on public.stream_runs(retention_expires_at) where retention_expires_at is not null;

create table if not exists public.stream_run_tool_calls (
  call_id uuid primary key,
  run_id uuid not null references public.stream_runs(id) on delete cascade,
  fence bigint not null,
  user_id text not null,
  owner_instance uuid not null,
  state text not null check (state in ('pending', 'settled', 'timed_out', 'cancelled')),
  deadline_at timestamptz not null
);
create index if not exists stream_run_tool_calls_run
  on public.stream_run_tool_calls(run_id, state);

revoke all on public.stream_run_nodes, public.stream_runs, public.stream_run_tool_calls
  from public, web_anon, authenticated;
grant select, insert, update, delete on public.stream_run_nodes, public.stream_runs,
  public.stream_run_tool_calls to service_role;
revoke all on sequence public.stream_run_fence_seq from public, web_anon, authenticated;
grant usage, select on sequence public.stream_run_fence_seq to service_role;

-- The ownership row is locked in the SAME transaction as the assistant-row
-- mutation. A separate assert_owner RPC followed by ordinary PostgREST UPDATE
-- would allow a stale writer to win after a successor claims the run key.
create or replace function public.fenced_update_assistant_message(
  p_run_id uuid, p_owner_token uuid, p_fence bigint,
  p_table text, p_chat_id uuid, p_message_id uuid,
  p_content jsonb, p_citations jsonb
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  if p_table not in ('chat_messages','word_chat_messages') then return 'invalid'; end if;
  perform 1 from public.stream_runs
  where id=p_run_id and owner_token=p_owner_token and fence=p_fence
    and state in ('running','stopping') and lease_expires_at>clock_timestamp()
    and lifetime_expires_at>clock_timestamp()
  for share;
  if not found then return 'stale'; end if;
  execute format('update public.%I set content=$1,citations=$2 where id=$3 and chat_id=$4 and role=''assistant''',p_table)
    using p_content,p_citations,p_message_id,p_chat_id;
  get diagnostics changed = row_count;
  return case when changed=1 then 'updated' else 'stale' end;
end;
$$;

create or replace function public.append_chat_assistant_events_fenced(
  p_run_id uuid, p_owner_token uuid, p_fence bigint,
  p_chat_id uuid, p_message_id uuid, p_author_user_id text,
  p_events jsonb, p_citations jsonb
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.stream_runs
  where id=p_run_id and owner_token=p_owner_token and fence=p_fence
    and state in ('running','stopping') and lease_expires_at>clock_timestamp()
    and lifetime_expires_at>clock_timestamp()
  for share;
  if not found then return 'stale'; end if;
  return public.append_chat_assistant_events(
    p_chat_id,p_message_id,p_author_user_id,p_events,p_citations
  );
end;
$$;

revoke all on function public.fenced_update_assistant_message(uuid,uuid,bigint,text,uuid,uuid,jsonb,jsonb)
  from public, web_anon, authenticated;
revoke all on function public.append_chat_assistant_events_fenced(uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb)
  from public, web_anon, authenticated;
grant execute on function public.fenced_update_assistant_message(uuid,uuid,bigint,text,uuid,uuid,jsonb,jsonb)
  to service_role;
grant execute on function public.append_chat_assistant_events_fenced(uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb)
  to service_role;
