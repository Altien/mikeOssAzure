-- Dev numbered adaptation of upstream 1672f736 memory safety boundaries.

-- Bind ask-input continuations to one durable assistant row and make their
-- event appends atomic and idempotent.
create or replace function public.append_chat_assistant_events(
  p_chat_id uuid,
  p_message_id uuid,
  p_author_user_id text,
  p_events jsonb,
  p_citations jsonb default '[]'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.chat_messages%rowtype;
begin
  if jsonb_typeof(p_events) is distinct from 'array'
     or jsonb_typeof(p_citations) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_assistant_events';
  end if;

  select * into target
  from public.chat_messages
  where id = p_message_id
    and chat_id = p_chat_id
    and role = 'assistant'
  for update;
  if not found then return 'stale'; end if;
  if target.author_user_id is distinct from p_author_user_id then
    return 'forbidden';
  end if;
  if target.content is not null and jsonb_typeof(target.content) <> 'array' then
    return 'stale';
  end if;
  if target.citations is not null
     and jsonb_typeof(target.citations) <> 'array' then
    return 'stale';
  end if;

  update public.chat_messages
  set content = coalesce(target.content, '[]'::jsonb) || p_events,
      citations = case
        when jsonb_array_length(p_citations) = 0 then target.citations
        else coalesce(target.citations, '[]'::jsonb) || p_citations
      end
  where id = target.id;
  return 'appended';
end;
$$;

create or replace function public.append_chat_ask_inputs_response(
  p_chat_id uuid,
  p_message_id uuid,
  p_author_user_id text,
  p_ask_event_id text,
  p_response jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.chat_messages%rowtype;
begin
  if coalesce(p_ask_event_id, '') = ''
     or (p_response->>'type') is distinct from 'ask_inputs_response'
     or (p_response->>'ask_event_id') is distinct from p_ask_event_id
     or (p_response->>'assistant_message_id') is distinct from p_message_id::text
     or jsonb_typeof(p_response->'responses') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_ask_inputs_response';
  end if;

  select * into target
  from public.chat_messages
  where id = p_message_id
    and chat_id = p_chat_id
    and role = 'assistant'
  for update;
  if not found then return 'stale'; end if;
  if target.author_user_id is distinct from p_author_user_id then
    return 'forbidden';
  end if;
  if jsonb_typeof(target.content) <> 'array' then return 'stale'; end if;
  if not exists (
    select 1
    from jsonb_array_elements(target.content) event
    where event->>'type' = 'ask_inputs'
      and event->>'event_id' = p_ask_event_id
  ) then
    return 'stale';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(target.content) event
    where event->>'type' = 'ask_inputs_response'
      and event->>'ask_event_id' = p_ask_event_id
  ) then
    return 'stale';
  end if;

  update public.chat_messages
  set content = target.content || jsonb_build_array(p_response)
  where id = target.id;
  return 'appended';
end;
$$;

-- Delete only the user's private memory files, in one transaction. A SHARE
-- lock prevents a direct grant from being inserted during scope resolution.
create or replace function public.delete_user_private_memories(
  p_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  deleted_projects integer := 0;
begin
  -- Project moves and sharing changes take ROW EXCLUSIVE locks. Hold the
  -- conflicting SHARE locks in parent-before-child order so a project cannot
  -- become organization-scoped or directly shared between eligibility and
  -- erasure.
  lock table public.projects in share mode;
  lock table public.project_access_grants in share mode;

  insert into public.memory_files(scope, user_id, enabled)
  values ('user', p_user_id, true)
  on conflict (user_id) do nothing;

  for target in
    select eligible.id, eligible.scope
    from (
      select file.id, file.scope
      from public.memory_files file
      where file.scope = 'user' and file.user_id = p_user_id
      union all
      select file.id, file.scope
      from public.memory_files file
      join public.projects project on project.id = file.project_id
      where file.scope = 'project'
        and project.user_id = p_user_id
        and project.org_id is null
        and not exists (
          select 1 from public.project_access_grants grant_row
          where grant_row.project_id = project.id
        )
    ) eligible
    order by eligible.id
  loop
    perform public.wipe_memory_file(target.id, null, p_user_id, 'wipe');
    if target.scope = 'project' then
      deleted_projects := deleted_projects + 1;
    end if;
  end loop;

  return deleted_projects;
end;
$$;

DO $grant$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname = ANY(ARRAY['append_chat_assistant_events','append_chat_ask_inputs_response','delete_user_private_memories'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, web_anon, authenticated', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
  END LOOP;
END $grant$;
