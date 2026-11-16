-- Support reports: a user reports a problem with one assistant response and
-- may allow the operator's support staff to inspect that conversation, up to
-- and including the reported response, and the project's documents for 14
-- days. The operator reads only through the cp_* functions below, as the
-- control_plane role; every consent, cut-off, expiry and withdrawal rule is
-- enforced here, never by the caller.
create table public.support_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default app.tenant_id_default() references public.tenants(tenant_id),
  user_id text not null,
  chat_id uuid not null,
  project_id uuid,
  message_id uuid not null,
  description text not null check (char_length(btrim(description)) between 1 and 4000),
  allow_conversation boolean not null default false,
  allow_documents boolean not null default false,
  consent_text text check (char_length(consent_text) <= 2000),
  created_at timestamptz not null default now(),
  access_expires_at timestamptz,
  withdrawn_at timestamptz,
  constraint support_reports_consent_wording check (
    not (allow_conversation or allow_documents) or nullif(btrim(consent_text), '') is not null),
  constraint support_reports_chat_fkey foreign key (tenant_id, chat_id)
    references public.chats(tenant_id, id) on delete cascade,
  constraint support_reports_message_fkey foreign key (tenant_id, message_id)
    references public.chat_messages(tenant_id, id) on delete cascade
);
create index support_reports_created_idx on public.support_reports(created_at, id);
create index support_reports_chat_idx on public.support_reports(tenant_id, chat_id);
create index support_reports_message_idx on public.support_reports(tenant_id, message_id);

-- The database, not the request, decides the project, the timestamps and the
-- expiry. The reported message must be a completed assistant response in the
-- reported chat. Withdrawal is one-way and server-timed.
create function app.guard_support_report() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_project uuid;
begin
  if tg_op = 'INSERT' then
    select c.project_id into v_project from public.chats c
      where c.tenant_id = new.tenant_id and c.id = new.chat_id;
    if not found then raise exception using errcode = '23503', message = 'Chat not found'; end if;
    perform 1 from public.chat_messages m
      where m.tenant_id = new.tenant_id and m.id = new.message_id and m.chat_id = new.chat_id
        and m.role = 'assistant' and m.content is not null;
    if not found then
      raise exception using errcode = '23503', message = 'Reported message is not a completed response in this chat';
    end if;
    new.project_id := v_project;
    new.created_at := now();
    new.withdrawn_at := null;
    new.access_expires_at := case when new.allow_conversation or new.allow_documents
      then now() + interval '14 days' end;
    return new;
  end if;
  if (to_jsonb(new) - 'withdrawn_at') is distinct from (to_jsonb(old) - 'withdrawn_at') then
    raise exception using errcode = '42501', message = 'Support reports are immutable';
  end if;
  new.withdrawn_at := coalesce(old.withdrawn_at, now());
  return new;
end $$;
revoke all on function app.guard_support_report() from public, web_anon, authenticated, tenant_app, control_plane;
create trigger guard_support_report before insert or update on public.support_reports
  for each row execute function app.guard_support_report();

-- Append-only record of every operator read. report_id deliberately has no
-- foreign key: the audit outlives a report deleted with its chat. Only the
-- fenced tenant purge may delete rows.
create table public.support_access_log (
  id bigint generated always as identity primary key,
  tenant_id text not null default app.tenant_id_default() references public.tenants(tenant_id),
  report_id uuid not null,
  kind text not null check (kind in ('report', 'conversation', 'document_list', 'document')),
  target_id text,
  actor text not null,
  at timestamptz not null default now()
);
create index support_access_log_report_idx on public.support_access_log(report_id, at);
create function app.reject_support_access_log_change() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' and current_setting('app.purging_tenant', true) = old.tenant_id then return old; end if;
  raise exception using errcode = '42501', message = 'Support access log is append-only';
end $$;
revoke all on function app.reject_support_access_log_change() from public, web_anon, authenticated, tenant_app, control_plane;
create trigger support_access_log_append_only before update or delete on public.support_access_log
  for each row execute function app.reject_support_access_log_change();

select app.enable_tenant_rls('public.support_reports');
select app.enable_tenant_rls('public.support_access_log');
create trigger tenant_offboarding_fence before insert or update on public.support_reports
  for each row execute function app.reject_offboarded_write();
create trigger tenant_offboarding_fence before insert or update on public.support_access_log
  for each row execute function app.reject_offboarded_write();

revoke all on public.support_reports, public.support_access_log
  from public, web_anon, authenticated, tenant_app, tenant_definer, control_plane;
grant select, insert(user_id, chat_id, message_id, description, allow_conversation, allow_documents, consent_text),
  update(withdrawn_at) on public.support_reports to tenant_app, service_role;
grant delete on public.support_reports to service_role;
grant select, insert, delete on public.support_access_log to service_role;

-- Shared gate for every report read: the report alone determines the tenant.
-- p_need names the consent the read requires; null reads only the report.
create function app.support_report_for_read(p_report_id uuid, p_actor text, p_need text)
returns public.support_reports language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare r public.support_reports;
begin
  if nullif(btrim(p_actor), '') is null or char_length(p_actor) > 200 then
    raise exception using errcode = '22023', message = 'Invalid support actor';
  end if;
  select * into r from public.support_reports where id = p_report_id;
  if not found then raise exception using errcode = '23503', message = 'Support report not found'; end if;
  if p_need is null then return r; end if;
  if (p_need = 'conversation' and not r.allow_conversation) or (p_need = 'documents' and not r.allow_documents) then
    raise exception using errcode = '42501', message = 'The user did not allow support access to the ' || p_need;
  end if;
  if r.withdrawn_at is not null then
    raise exception using errcode = '42501', message = 'The user withdrew support access';
  end if;
  if r.access_expires_at is null or r.access_expires_at <= now() then
    raise exception using errcode = '42501', message = 'Support access has expired';
  end if;
  return r;
end $$;

-- The documents a report may expose: its project's documents, or, without a
-- project, the documents attached to the chat up to the reported message.
create function app.support_report_document_ids(r public.support_reports)
returns setof uuid language sql stable set search_path = pg_catalog, pg_temp as $$
  select d.id from public.documents d
    where d.tenant_id = r.tenant_id and r.project_id is not null and d.project_id = r.project_id
  union
  select d.id from public.chat_messages cut
    join public.chat_messages m on m.tenant_id = cut.tenant_id and m.chat_id = cut.chat_id
      and (m.created_at, m.id) <= (cut.created_at, cut.id)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(m.files) = 'array' then m.files else '[]'::jsonb end) f
    join public.documents d on d.tenant_id = r.tenant_id
      and d.id::text = lower(f->>'document_id')
    where r.project_id is null and cut.tenant_id = r.tenant_id and cut.id = r.message_id
$$;
revoke all on function app.support_report_for_read(uuid, text, text), app.support_report_document_ids(public.support_reports)
  from public, web_anon, authenticated, tenant_app, tenant_definer, control_plane;
grant execute on function app.support_report_for_read(uuid, text, text), app.support_report_document_ids(public.support_reports)
  to service_role;

create function public.cp_list_support_reports(p_since timestamptz default null, p_tenant_id text default null, p_limit integer default 100)
returns table(report_id uuid, tenant_id text, user_id text, chat_id uuid, project_id uuid, message_id uuid,
  description text, allow_conversation boolean, allow_documents boolean, created_at timestamptz,
  access_expires_at timestamptz, withdrawn_at timestamptz, access_live boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select r.id, r.tenant_id, r.user_id, r.chat_id, r.project_id, r.message_id, r.description,
    r.allow_conversation, r.allow_documents, r.created_at, r.access_expires_at, r.withdrawn_at,
    (r.allow_conversation or r.allow_documents) and r.withdrawn_at is null and r.access_expires_at > now()
  from public.support_reports r
  where (p_since is null or r.created_at > p_since) and (p_tenant_id is null or r.tenant_id = p_tenant_id)
  order by r.created_at, r.id
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

-- The report and a content-free technical trace of the chat up to the
-- reported response: message shape, run/turn status, usage and credits. No
-- message, title, prompt or document content. Available without consent.
create function public.cp_read_support_report(p_report_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r public.support_reports; v_cut public.chat_messages; v_until timestamptz; v_users text[]; v_result jsonb;
begin
  r := app.support_report_for_read(p_report_id, p_actor, null);
  select * into v_cut from public.chat_messages where tenant_id = r.tenant_id and id = r.message_id;
  -- The trace ends where the conversation moved on, or at the report.
  select least(r.created_at, min(m.created_at)) into v_until from public.chat_messages m
    where m.tenant_id = r.tenant_id and m.chat_id = r.chat_id and (m.created_at, m.id) > (v_cut.created_at, v_cut.id);
  v_until := coalesce(v_until, r.created_at);
  select array_agg(distinct u) filter (where u is not null) into v_users from (
    select m.author_user_id as u from public.chat_messages m
      where m.tenant_id = r.tenant_id and m.chat_id = r.chat_id and (m.created_at, m.id) <= (v_cut.created_at, v_cut.id)
    union all select c.user_id from public.chats c where c.tenant_id = r.tenant_id and c.id = r.chat_id
    union all select r.user_id) x;
  with msgs as (
    select m.id, m.role, m.created_at, m.content, m.files, m.citations,
      coalesce(lead(m.created_at) over (order by m.created_at, m.id), r.created_at) as next_at
    from public.chat_messages m where m.tenant_id = r.tenant_id and m.chat_id = r.chat_id
  ), shown as (
    select * from msgs where (created_at, id) <= (v_cut.created_at, v_cut.id)
  ), turn_usage as (
    select distinct on (e.id, e.created_at) e.* from public.llm_usage_events e
      join shown s on s.role = 'assistant' and e.created_at >= s.created_at and e.created_at <= least(s.next_at, v_until)
      where e.tenant_id = r.tenant_id and e.user_id = any(v_users)
  )
  select jsonb_build_object(
    'report', jsonb_build_object('report_id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id,
      'chat_id', r.chat_id, 'project_id', r.project_id, 'message_id', r.message_id, 'description', r.description,
      'allow_conversation', r.allow_conversation, 'allow_documents', r.allow_documents, 'consent_text', r.consent_text,
      'created_at', r.created_at, 'access_expires_at', r.access_expires_at, 'withdrawn_at', r.withdrawn_at,
      'access_live', (r.allow_conversation or r.allow_documents) and r.withdrawn_at is null and r.access_expires_at > now()),
    'trace', jsonb_build_object(
      'until', v_until,
      'chat', (select jsonb_build_object('created_at', c.created_at, 'model', c.model, 'reasoning_level', c.reasoning_level)
        from public.chats c where c.tenant_id = r.tenant_id and c.id = r.chat_id),
      'messages', coalesce((select jsonb_agg(jsonb_build_object('message_id', s.id, 'role', s.role, 'created_at', s.created_at,
          'content_chars', length(s.content::text),
          'file_count', case when jsonb_typeof(s.files) = 'array' then jsonb_array_length(s.files) else 0 end,
          'citation_count', case when jsonb_typeof(s.citations) = 'array' then jsonb_array_length(s.citations) else 0 end)
        order by s.created_at, s.id) from shown s), '[]'::jsonb),
      'stream_runs', coalesce((select jsonb_agg(jsonb_build_object('run_id', sr.id, 'surface', sr.surface, 'state', sr.state,
          'assistant_message_id', sr.meta->>'assistantMessageId', 'started_at', sr.started_at, 'finished_at', sr.finished_at,
          'terminal_reason', sr.terminal_reason) order by sr.started_at)
        from public.stream_runs sr where sr.tenant_id = r.tenant_id and sr.meta->>'chatId' = r.chat_id::text
          and sr.started_at <= v_until), '[]'::jsonb),
      'audit_events', coalesce((select jsonb_agg(jsonb_build_object('event_id', a.id, 'created_at', a.created_at,
          'action', a.action, 'status', a.status, 'surface', a.surface, 'model', a.model) order by a.created_at)
        from public.audit_events a where a.tenant_id = r.tenant_id and a.chat_id = r.chat_id
          and a.created_at <= v_until), '[]'::jsonb),
      'usage', coalesce((select jsonb_agg(jsonb_build_object('created_at', u.created_at, 'completed_at', u.completed_at,
          'feature', u.feature, 'provider', u.provider, 'model', u.model, 'key_mode', u.key_mode,
          'input_tokens', u.input_tokens, 'output_tokens', u.output_tokens, 'cache_read_tokens', u.cache_read_tokens,
          'cache_write_tokens', u.cache_write_tokens, 'steps', u.steps, 'usage_estimated', u.usage_estimated,
          'outcome', u.outcome, 'latency_ms', u.latency_ms, 'credits', u.credits,
          'credit_reservation_id', u.credit_reservation_id) order by u.created_at) from turn_usage u), '[]'::jsonb),
      'credit_reservations', coalesce((select jsonb_agg(jsonb_build_object('reservation_id', cr.id, 'created_at', cr.created_at,
          'settled_at', cr.settled_at, 'provider', cr.provider, 'model', cr.model, 'max_output_tokens', cr.max_output_tokens,
          'reserved_credits', cr.reserved_credits, 'settled_credits', cr.settled_credits) order by cr.created_at)
        from public.tenant_credit_reservations cr where cr.tenant_id = r.tenant_id
          and cr.id in (select u.credit_reservation_id from turn_usage u)), '[]'::jsonb)))
  into v_result;
  insert into public.support_access_log(tenant_id, report_id, kind, target_id, actor)
    values(r.tenant_id, r.id, 'report', r.id::text, btrim(p_actor));
  return v_result;
end $$;

-- The conversation up to AND including the reported response, nothing after.
create function public.cp_read_support_conversation(p_report_id uuid, p_actor text)
returns table(message_id uuid, role text, created_at timestamptz, content jsonb, files jsonb,
  citations jsonb, annotations jsonb, workflow jsonb, playbook jsonb)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r public.support_reports;
begin
  r := app.support_report_for_read(p_report_id, p_actor, 'conversation');
  insert into public.support_access_log(tenant_id, report_id, kind, target_id, actor)
    values(r.tenant_id, r.id, 'conversation', r.message_id::text, btrim(p_actor));
  return query
    select m.id, m.role, m.created_at, m.content, m.files, m.citations, m.annotations, m.workflow, m.playbook
    from public.chat_messages cut
    join public.chat_messages m on m.tenant_id = cut.tenant_id and m.chat_id = cut.chat_id
      and (m.created_at, m.id) <= (cut.created_at, cut.id)
    where cut.tenant_id = r.tenant_id and cut.id = r.message_id and cut.chat_id = r.chat_id
    order by m.created_at, m.id;
end $$;

create function public.cp_list_support_documents(p_report_id uuid, p_actor text)
returns table(document_id uuid, version_id uuid, filename text, file_type text, size_bytes integer,
  page_count integer, version_number integer, created_at timestamptz, updated_at timestamptz, text_status text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r public.support_reports;
begin
  r := app.support_report_for_read(p_report_id, p_actor, 'documents');
  insert into public.support_access_log(tenant_id, report_id, kind, target_id, actor)
    values(r.tenant_id, r.id, 'document_list', coalesce(r.project_id, r.chat_id)::text, btrim(p_actor));
  return query
    select d.id, v.id, v.filename, v.file_type, v.size_bytes, v.page_count, v.version_number, d.created_at, d.updated_at,
      case when t.status = 'ready' and t.source_revision <> v.text_revision then 'stale'
        else coalesce(t.status, 'missing') end
    from public.documents d
    left join lateral (select * from public.document_versions dv
      where dv.tenant_id = d.tenant_id and dv.document_id = d.id and dv.deleted_at is null
      order by (dv.id = d.current_version_id) desc, dv.created_at desc limit 1) v on true
    left join public.document_version_texts t on t.tenant_id = d.tenant_id and t.version_id = v.id
    where d.tenant_id = r.tenant_id and d.id in (select app.support_report_document_ids(r))
    order by v.filename, d.id;
end $$;

-- One in-scope document: metadata, its blob paths, and the extracted text of
-- its current version when extraction is ready and current.
create function public.cp_read_support_document(p_report_id uuid, p_document_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r public.support_reports; v_result jsonb;
begin
  r := app.support_report_for_read(p_report_id, p_actor, 'documents');
  if p_document_id is null or p_document_id not in (select app.support_report_document_ids(r)) then
    raise exception using errcode = '23503', message = 'Document not found in this support report';
  end if;
  select jsonb_build_object('document_id', d.id, 'version_id', v.id, 'filename', v.filename, 'file_type', v.file_type,
      'size_bytes', v.size_bytes, 'page_count', v.page_count, 'version_number', v.version_number,
      'storage_path', v.storage_path, 'pdf_storage_path', v.pdf_storage_path,
      'text_status', case when t.status = 'ready' and t.source_revision <> v.text_revision then 'stale'
        else coalesce(t.status, 'missing') end,
      'text_content', case when t.status = 'ready' and t.source_revision = v.text_revision then t.text_content end)
    into v_result
    from public.documents d
    left join lateral (select * from public.document_versions dv
      where dv.tenant_id = d.tenant_id and dv.document_id = d.id and dv.deleted_at is null
      order by (dv.id = d.current_version_id) desc, dv.created_at desc limit 1) v on true
    left join public.document_version_texts t on t.tenant_id = d.tenant_id and t.version_id = v.id
    where d.tenant_id = r.tenant_id and d.id = p_document_id;
  insert into public.support_access_log(tenant_id, report_id, kind, target_id, actor)
    values(r.tenant_id, r.id, 'document', p_document_id::text, btrim(p_actor));
  return v_result;
end $$;

do $$ declare v_had boolean := has_schema_privilege('service_role', 'public', 'CREATE'); v_signature text; begin
  grant create on schema public to service_role;
  foreach v_signature in array array['cp_list_support_reports(timestamptz,text,integer)',
    'cp_read_support_report(uuid,text)', 'cp_read_support_conversation(uuid,text)',
    'cp_list_support_documents(uuid,text)', 'cp_read_support_document(uuid,uuid,text)'] loop
    execute format('alter function public.%s owner to service_role', v_signature);
    execute format('revoke all on function public.%s from public,web_anon,authenticated,tenant_app,tenant_definer', v_signature);
    execute format('grant execute on function public.%s to service_role,control_plane', v_signature);
  end loop;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;

-- Extend both platform-function lists and the control_plane executable set.
do $$ declare v_definition text; begin
  select pg_get_functiondef('app.tenant_rls_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition, '''cp_add_member'',',
    '''cp_list_support_reports'', ''cp_read_support_report'', ''cp_read_support_conversation'', ''cp_list_support_documents'', ''cp_read_support_document'', ''cp_add_member'',');
  select pg_get_functiondef('app.control_plane_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition, '''public.cp_add_directory_member(text,text,text,text)''::regprocedure]',
    '''public.cp_add_directory_member(text,text,text,text)''::regprocedure,''public.cp_list_support_reports(timestamptz,text,integer)''::regprocedure,'
    || '''public.cp_read_support_report(uuid,text)''::regprocedure,''public.cp_read_support_conversation(uuid,text)''::regprocedure,'
    || '''public.cp_list_support_documents(uuid,text)''::regprocedure,''public.cp_read_support_document(uuid,uuid,text)''::regprocedure]');
end $$;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps
    from (select * from app.tenant_rls_gaps() union all select * from app.control_plane_gaps()) g;
  if v_gaps is not null then raise exception 'support reports: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
