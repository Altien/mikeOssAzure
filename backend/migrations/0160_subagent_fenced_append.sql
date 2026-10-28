-- Source178: extend the canonical owner-fenced parent append, never a second persistence path.
-- Default arguments keep existing chat/Word callers compatible. Only continuation
-- writes require a live running owner and current actor/resource scope.
drop function if exists public.append_chat_assistant_events_fenced(uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb);
create or replace function public.append_chat_assistant_events_fenced(
  p_run_id uuid, p_owner_token uuid, p_fence bigint,
  p_chat_id uuid, p_message_id uuid, p_author_user_id text,
  p_events jsonb, p_citations jsonb,
  p_subagent_runs jsonb default '[]'::jsonb,
  p_user_email text default null, p_org_id uuid default null
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare
  claimed public.stream_runs; chat public.chats; current_org uuid;
  continuation jsonb; ref jsonb; doc public.documents; version public.document_versions;
  doc_org uuid; result text; scope_org uuid;
begin
  select * into claimed from public.stream_runs
  where id=p_run_id and owner_token=p_owner_token and fence=p_fence
    and state in ('running','stopping') and lease_expires_at>clock_timestamp()
    and lifetime_expires_at>clock_timestamp() for share;
  if not found then return 'stale'; end if;
  if p_subagent_runs is null or jsonb_typeof(p_subagent_runs)<>'array'
    or jsonb_array_length(p_subagent_runs)>8 then return 'invalid'; end if;
  if jsonb_array_length(p_subagent_runs)>0 then
    if claimed.state<>'running' or claimed.user_id is distinct from p_author_user_id
      or claimed.surface<>'chat' or claimed.meta->>'chatId' is distinct from p_chat_id::text
      or claimed.meta->>'assistantMessageId' is distinct from p_message_id::text
    then return 'stale'; end if;
    -- Lock the canonical access inputs for this short append transaction. This
    -- prevents a revoke, placement/version change or archive between validation
    -- and saving the retained transcript. No provider-auth or alternate access layer.
    lock table public.organizations,public.org_members,public.projects,public.workflows,
      public.documents,public.document_versions,public.chats,
      public.project_access_grants,public.chat_access_grants,public.workflow_shares,
      public.project_org_access_overrides,public.workflow_org_access_overrides,
      public.org_private_content_access in share mode;
    select * into chat from public.chats where id=p_chat_id and archived_at is null;
    if not found or coalesce(public.chat_access_role(chat.id,chat.user_id,chat.project_id,chat.org_id,
        p_author_user_id,p_user_email),'') not in ('owner','editor')
    then return 'forbidden'; end if;
    current_org:=chat.org_id;
    if chat.project_id is not null then
      select org_id into current_org from public.projects where id=chat.project_id and archived_at is null;
      if not found then return 'forbidden'; end if;
    end if;
    if not public.org_is_active(current_org) or not public.org_is_active(p_org_id) then return 'forbidden'; end if;
    current_org:=case when public.org_is_team(current_org) then current_org else null end;
    scope_org:=case when public.org_is_team(p_org_id) then p_org_id else null end;
    if not public.org_is_active(current_org) or current_org is distinct from scope_org
      then return 'forbidden'; end if;
    for continuation in select value from jsonb_array_elements(p_subagent_runs) loop
      if jsonb_typeof(continuation)<>'object'
        or continuation->>'chat_id' is distinct from p_chat_id::text
        or continuation->>'message_id' is distinct from p_message_id::text
        or continuation->>'user_id' is distinct from p_author_user_id
        or continuation->>'org_id' is distinct from scope_org::text
        or coalesce(continuation->>'status','') not in ('completed','incomplete','needs_input')
        or coalesce(length(continuation->>'delegation_id'),0) not between 1 and 100
        or jsonb_typeof(continuation->'transcript') is distinct from 'object'
        or continuation->'transcript'->>'v' is distinct from '1'
        or octet_length((continuation->'transcript')::text)>400000
        or jsonb_typeof(continuation->'transcript'->'records') is distinct from 'array'
        or (continuation->'transcript' ? 'documents' and
            jsonb_typeof(continuation->'transcript'->'documents') is distinct from 'array')
      then return 'invalid'; end if;
      for ref in
        select jsonb_build_object('document_id',value #>> '{}')
          from jsonb_array_elements(coalesce(continuation->'transcript'->'documents','[]'::jsonb))
        union all
        select document_ref.value from jsonb_array_elements(continuation->'transcript'->'records') record,
          lateral jsonb_array_elements(coalesce(record.value->'documents','[]'::jsonb)) document_ref
      loop
        select * into doc from public.documents where id=(ref->>'document_id')::uuid and archived_at is null;
        if not found or not public.document_text_access(doc.id,p_author_user_id,p_user_email)
          then return 'forbidden'; end if;
        doc_org:=doc.org_id;
        if doc.workflow_id is not null then
          select org_id into doc_org from public.workflows where id=doc.workflow_id and archived_at is null;
          if not found then return 'forbidden'; end if;
        elsif doc.project_id is not null then
          select org_id into doc_org from public.projects where id=doc.project_id and archived_at is null;
          if not found then return 'forbidden'; end if;
        end if;
        doc_org:=case when public.org_is_team(doc_org) then doc_org else null end;
        if doc_org is distinct from scope_org then return 'forbidden'; end if;
        if ref->>'version_id' is not null then
          select * into version from public.document_versions
            where id=(ref->>'version_id')::uuid and document_id=doc.id and deleted_at is null;
          if not found then return 'forbidden'; end if;
        end if;
      end loop;
      if exists(select 1 from public.chat_subagent_runs saved
        where saved.chat_id=p_chat_id and saved.delegation_id=continuation->>'delegation_id'
          and (saved.user_id is distinct from p_author_user_id or saved.message_id is distinct from p_message_id
            or saved.org_id is distinct from scope_org)) then return 'forbidden'; end if;
    end loop;
  end if;
  -- Acquire the canonical parent lock before the final time fence, so a
  -- wait on another appender cannot consume the lease after validation.
  perform 1 from public.chat_messages where id=p_message_id and chat_id=p_chat_id for update;
  if claimed.lease_expires_at<=clock_timestamp() or claimed.lifetime_expires_at<=clock_timestamp()
    then return 'stale'; end if;
  -- Parent row author/chat/role lock is acquired by the existing canonical append.
  result:=public.append_chat_assistant_events(p_chat_id,p_message_id,p_author_user_id,p_events,p_citations);
  if result<>'appended' then return result; end if;
  insert into public.chat_subagent_runs(chat_id,message_id,delegation_id,user_id,org_id,status,transcript)
    select p_chat_id,p_message_id,saved_row->>'delegation_id',p_author_user_id,scope_org,saved_row->>'status',saved_row->'transcript'
    from jsonb_array_elements(p_subagent_runs) saved_row
    on conflict(chat_id,delegation_id) do nothing;
  return result;
end;
$$;
revoke all on function public.append_chat_assistant_events_fenced(uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb,jsonb,text,uuid)
  from public,web_anon,authenticated;
grant execute on function public.append_chat_assistant_events_fenced(uuid,uuid,bigint,uuid,uuid,text,jsonb,jsonb,jsonb,text,uuid)
  to service_role;
notify pgrst,'reload schema';
