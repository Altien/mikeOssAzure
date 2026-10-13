-- Dev numbered workspace library/upload provenance and private RPCs.
-- Migration date: 2026-10-13
--
-- The library, and documents uploaded on their own, belong to a workspace.
--
-- A document carried an organization only by sitting in one of its projects
-- or workflows. One uploaded to the library, or attached to a chat, was
-- personal wherever its uploader was working, so an organization's chat
-- could only ever hold personal documents, and the library was one list
-- across every workspace.
--
-- A document uploaded on its own in an organization's workspace now belongs
-- to that organization (the backend stamps documents.org_id), and so do the
-- library folders made there. Both are private to the person who made them:
-- the library shows a person their own documents for the active workspace,
-- and nobody else's.
--
--   library_folders.org_id   the workspace a folder is in; null is Personal
--   p_workspace              on the three library list functions
--   target_org_id            on resolve_library_folder_path
--
-- Like their chats and reviews there, a member's own documents in an
-- organization are deleted when they leave it; documents in a project or a
-- workflow belong to that and stay.
--
-- Safe to re-run: add column / create index if not exists, drop-before-
-- create for the constraint and the replaced function signatures.

alter table public.library_folders
  add column if not exists org_id uuid;

-- Tied to the membership, as a person's memory for a workspace is: leaving,
-- being removed and the organization being deleted all take the folder.
-- Dev TEXT library owner / UUID membership seam, as in0122.
alter table public.library_folders
  drop constraint if exists library_folders_workspace_org_fkey;
alter table public.library_folders
  add constraint library_folders_workspace_org_fkey
  foreign key (org_id) references public.organizations(id) on delete cascade;

create or replace function public.guard_workspace_library_membership()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.org_id is not null then
    perform 1 from public.org_members member
    where member.org_id = new.org_id and member.user_id::text = new.user_id
    for key share;
    if not found then
      raise exception 'Workspace library requires current membership' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists library_folders_workspace_member_guard on public.library_folders;
create trigger library_folders_workspace_member_guard
  before insert or update of org_id, user_id on public.library_folders
  for each row execute function public.guard_workspace_library_membership();

create or replace function public.cleanup_departed_workspace_library()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.library_folders folder
  where folder.org_id = old.org_id and folder.user_id = old.user_id::text;
  return old;
end;
$$;
drop trigger if exists org_members_cleanup_workspace_library on public.org_members;
create trigger org_members_cleanup_workspace_library
  after delete on public.org_members
  for each row execute function public.cleanup_departed_workspace_library();

create index if not exists idx_library_folders_org
  on public.library_folders(org_id) where org_id is not null;

-- The three list functions take the workspace to show: null does not
-- narrow, 'personal' is documents with no organization, and an organization
-- id is that organization's (public.workspace_matches). They only ever show
-- the caller their own documents.
drop function if exists public.search_library_documents(
  text, text, integer, integer, text, text, text, text
);
create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc',
  p_workspace text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  textless_page_count integer,
  active_version_number integer
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.project_id,
    d.user_id::text as user_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.textless_page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and public.workspace_matches(p_workspace, d.org_id)
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then coalesce(v.size_bytes, 0) else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then coalesce(v.size_bytes, 0) else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then coalesce(v.version_number, 0) else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then coalesce(v.version_number, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_library_filter_options(text, text);
create or replace function public.get_library_filter_options(
  p_user_id text,
  p_library_kind text,
  p_workspace text default null
)
returns table (file_types text[])
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    array_agg(distinct lower(v.file_type) order by lower(v.file_type))
      filter (where nullif(trim(v.file_type), '') is not null),
    array[]::text[]
  ) as file_types
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and public.workspace_matches(p_workspace, d.org_id)
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    );
$$;

drop function if exists public.get_library_document_ids(
  text, text, text, text, integer, integer
);
create or replace function public.get_library_document_ids(
  p_user_id text,
  p_library_kind text,
  p_search_term text,
  p_file_type text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select d.id, d.user_id::text as user_id
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and public.workspace_matches(p_workspace, d.org_id)
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by d.updated_at desc, d.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Folders are found and made within one workspace: the same name may exist
-- in Personal and in an organization, and a path never crosses between them.
drop function if exists public.resolve_library_folder_path(
  text, text, uuid, text[], text
);
create or replace function public.resolve_library_folder_path(
  target_user_id text,
  target_library_kind text,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error',
  target_org_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.library_folders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if target_library_kind not in ('file', 'template') then
    raise exception 'Invalid library kind';
  end if;
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.library_folders
    where id = base_folder_id
      and user_id = target_user_id
      and library_kind = target_library_kind
      and org_id is not distinct from target_org_id
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'library-folder-path:' || target_user_id::text || ':' || target_library_kind
        || ':' || coalesce(target_org_id::text, 'personal'),
      0
    )
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.library_folders
    where user_id = target_user_id
      and library_kind = target_library_kind
      and org_id is not distinct from target_org_id
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.library_folders
          where user_id = target_user_id
            and library_kind = target_library_kind
            and org_id is not distinct from target_org_id
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.library_folders (
        user_id, library_kind, name, parent_folder_id, org_id
      ) values (
        target_user_id, target_library_kind, resolved_name, current_parent_id,
        target_org_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

revoke all on function public.resolve_library_folder_path(text, text, uuid, text[], text, uuid)
  from public, web_anon, authenticated;
grant execute on function public.resolve_library_folder_path(text, text, uuid, text[], text, uuid)
  to service_role;

-- What a member's leaving deletes now includes their own documents there.
create or replace function public.org_member_private_standalone(
  p_org_id uuid,
  p_user_id text
)
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public, pg_temp
as $$
  select 'chat'::text, c.id
  from public.chats c
  where c.org_id = p_org_id
    and c.project_id is null
    and c.user_id = p_user_id
    and not exists (
      select 1
      from public.chat_access_grants g
      join public.user_profiles holder on lower(holder.email) = g.email
      join public.org_members m
        on m.user_id = holder.user_id and m.org_id = p_org_id
      where g.chat_id = c.id
        and g.role = 'owner'
        and holder.user_id::text <> p_user_id
    )
  union all
  select 'tabular_review'::text, r.id
  from public.tabular_reviews r
  where r.org_id = p_org_id
    and r.project_id is null
    and r.user_id = p_user_id
    and not exists (
      select 1
      from public.tabular_review_access_grants g
      join public.user_profiles holder on lower(holder.email) = g.email
      join public.org_members m
        on m.user_id = holder.user_id and m.org_id = p_org_id
      where g.tabular_review_id = r.id
        and g.role = 'owner'
        and holder.user_id::text <> p_user_id
    )
  union all
  -- Their own documents in the organization's workspace: what they uploaded
  -- to the library there or attached to a chat. One in a project or a
  -- workflow belongs to that, and stays.
  select 'document'::text, d.id
  from public.documents d
  where d.org_id = p_org_id
    and d.project_id is null
    and d.workflow_id is null
    and d.user_id = p_user_id;
$$;

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  delete from public.project_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.workflow_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.chat_access_grants g
  using public.chats c, public.user_profiles holder
  where g.chat_id = c.id
    and c.org_id = old.org_id
    and c.project_id is null
    and holder.user_id = old.user_id
    and g.email = lower(holder.email);
  delete from public.tabular_review_access_grants g
  using public.tabular_reviews r, public.user_profiles holder
  where g.tabular_review_id = r.id
    and r.org_id = old.org_id
    and r.project_id is null
    and holder.user_id = old.user_id
    and g.email = lower(holder.email);
  -- Team organizations only, and only while the organization itself is
  -- staying: when it is being deleted its content has already been dealt
  -- with, and its row is gone by the time this runs.
  if public.org_is_team(old.org_id) then
    delete from public.chats c
    using public.org_member_private_standalone(old.org_id, old.user_id::text) gone
    where gone.kind = 'chat' and c.id = gone.item_id;
    delete from public.tabular_reviews r
    using public.org_member_private_standalone(old.org_id, old.user_id::text) gone
    where gone.kind = 'tabular_review' and r.id = gone.item_id;
    -- Deleting the row retires its versions, and their stored files with
    -- them (queue_document_version_cleanup).
    delete from public.documents d
    using public.org_member_private_standalone(old.org_id, old.user_id::text) gone
    where gone.kind = 'document' and d.id = gone.item_id;
  end if;
  return old;
end;
$$;

-- Dev fenced publisher adaptation; all claim/lease/CAS/cleanup fences retained.
create or replace function public.finish_upload_processing_job(
  p_job_id uuid, p_worker_id text, p_attempt integer, p_token uuid,
  p_payload jsonb, p_failure text default null,
  p_lease_seconds integer default 1800
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.upload_processing_jobs%rowtype;
  f public.upload_session_files%rowtype;
  s public.upload_sessions%rowtype;
  d public.documents%rowtype;
  v public.document_versions%rowtype;
  r public.workflow_reference_documents%rowtype;
  published_result jsonb;
  next_version integer;
  reference_id uuid;
  owner_id text;
  cleanup_paths text[];
  document_org_id uuid;
  workflow_owner text;
  workflow_type text;
begin
  select * into j from public.upload_processing_jobs where id=p_job_id for update;
  if not found or j.status <> 'running' or j.locked_by <> p_worker_id
    or j.attempts <> p_attempt or j.claim_token <> p_token
    or j.locked_at <= now()-make_interval(secs=>p_lease_seconds) then return null; end if;
  select * into f from public.upload_session_files where id=j.file_id and session_id=j.session_id for update;
  select * into s from public.upload_sessions where id=j.session_id for update;
  if f.id is null or s.id is null or s.user_id <> j.user_id or f.status <> 'processing'
     or s.status in ('cancelled','expired','error','completed') then return null; end if;
  if p_failure is not null then
    if p_failure not in ('processing_failed','document_changed') then raise exception 'invalid_upload_failure'; end if;
    if p_failure = 'document_changed' then
      -- Terminal: retrying a stale editor save cannot succeed.
      if s.purpose <> 'document_version_replace' then raise exception 'invalid_upload_failure'; end if;
      update public.upload_processing_jobs set status='completed', locked_at=null, locked_by=null,
        claim_token=null, error_code=p_failure, updated_at=now() where id=j.id;
      update public.upload_session_files set status='error', error_code=p_failure, updated_at=now() where id=f.id;
      insert into public.db_jobs(kind,payload,max_attempts)
        values('storage.cleanup',jsonb_build_object('keys',
          to_jsonb(array_remove(array[f.staging_storage_path,f.sealed_storage_path],null)),'prefixes','[]'::jsonb),8);
      perform public.refresh_upload_session_status(s.id);
      return jsonb_build_object('status','error','error_code',p_failure);
    end if;
    if j.attempts < 3 then
      update public.upload_processing_jobs set status='queued', available_at=now()+make_interval(secs=>j.attempts*5),
        locked_at=null, locked_by=null, claim_token=null, error_code=p_failure, updated_at=now() where id=j.id;
      update public.upload_session_files set status='uploaded', error_code=null, updated_at=now() where id=f.id;
    else
      update public.upload_processing_jobs set status='completed', locked_at=null, locked_by=null,
        claim_token=null, error_code='partial_failure', updated_at=now() where id=j.id;
      update public.upload_session_files set status='error', error_code=p_failure, updated_at=now() where id=f.id;
    end if;
    perform public.refresh_upload_session_status(s.id);
    return jsonb_build_object('status',case when j.attempts<3 then 'retry' else 'error' end);
  end if;
  if p_payload is null or p_payload->>'kind' <> s.purpose
    or length(coalesce(p_payload->>'source_path','')) < 1
    or (p_payload->>'size_bytes')::bigint <> f.expected_size_bytes then
    raise exception 'invalid_upload_result';
  end if;
  cleanup_paths := array[f.staging_storage_path,f.sealed_storage_path];

  if s.purpose = 'document_create' then
    -- Upstream f7a8f0d8 workspace provenance is published atomically under
    -- this current job claim, never by an unfenced worker-side upsert.
    document_org_id := null;
    if s.destination->>'scope' in ('standalone','library') then
      document_org_id := (s.destination->>'org_id')::uuid;
      if document_org_id is not null then
        perform 1 from public.org_members member
        where member.org_id=document_org_id and member.user_id::text=s.user_id
        for key share;
        if not found then raise exception 'workspace_not_found' using errcode='23503'; end if;
      end if;
    elsif s.destination->>'scope'='workflow' then
      select workflow.org_id into document_org_id from public.workflows workflow
      where workflow.id=(s.destination->>'workflow_id')::uuid for key share;
      if not found then raise exception 'workflow_not_found'; end if;
    end if;
    if s.destination->>'scope' = 'workflow' then
      select user_id,type into workflow_owner,workflow_type from public.workflows
        where id=(s.destination->>'workflow_id')::uuid;
      if not found or workflow_type <> 'assistant' or not (
        workflow_owner = s.user_id or exists (
          select 1 from public.workflow_shares share
          where share.workflow_id=(s.destination->>'workflow_id')::uuid
            and share.shared_with_email=lower(trim(s.user_email))
            and share.allow_edit = true
        )
      ) then raise exception 'workflow_asset_edit_denied'; end if;
    end if;
    insert into public.documents(id,project_id,user_id,status,folder_id,library_kind,library_folder_id,workflow_id,org_id)
    values(f.resource_id,(p_payload->>'project_id')::uuid,s.user_id,'processing',
      (p_payload->>'folder_id')::uuid,
      case when s.destination->>'scope'='workflow' then 'workflow_asset'
           else coalesce(p_payload->>'library_kind','file') end,
      (p_payload->>'library_folder_id')::uuid,
      case when s.destination->>'scope'='workflow' then (s.destination->>'workflow_id')::uuid else null end, document_org_id);
    insert into public.document_versions(id,document_id,storage_path,pdf_storage_path,source,
      version_number,filename,file_type,size_bytes,page_count,textless_page_count,content_sha256)
    values(f.id,f.resource_id,p_payload->>'source_path',p_payload->>'pdf_path','upload',
      1,f.filename,f.file_type,f.expected_size_bytes,(p_payload->>'page_count')::integer,
      (p_payload->>'textless_page_count')::integer,p_payload->>'sha256');
    update public.documents set current_version_id=f.id,status='ready',updated_at=now() where id=f.resource_id returning * into d;
    published_result := to_jsonb(d) || jsonb_build_object('filename',f.filename,'storage_path',p_payload->>'source_path',
      'pdf_storage_path',p_payload->>'pdf_path','folder_id',coalesce(d.library_folder_id,d.folder_id),
      'file_type',f.file_type,'size_bytes',f.expected_size_bytes,
      'page_count',(p_payload->>'page_count')::integer,
      'textless_page_count',(p_payload->>'textless_page_count')::integer,'active_version_number',1);
  elsif s.purpose = 'document_version_create' then
    select * into d from public.documents where id=(s.destination->>'document_id')::uuid for update;
    if not found then raise exception 'document_not_found'; end if;
    if d.workflow_id is null then
      if d.user_id <> s.user_id then raise exception 'document_edit_denied'; end if;
    else
      select user_id,type into workflow_owner,workflow_type from public.workflows where id=d.workflow_id;
      if not found or workflow_type <> 'assistant' or not (
        workflow_owner = s.user_id or exists (
          select 1 from public.workflow_shares share
          where share.workflow_id=d.workflow_id
            and share.shared_with_email=lower(trim(s.user_email))
            and share.allow_edit = true
        )
      ) then raise exception 'workflow_asset_edit_denied'; end if;
    end if;
    select coalesce(max(version_number),1)+1 into next_version from public.document_versions
      where document_id=d.id and source in ('upload','user_upload','assistant_edit');
    insert into public.document_versions(id,document_id,storage_path,pdf_storage_path,source,
      version_number,filename,file_type,size_bytes,page_count,textless_page_count,content_sha256)
    values(f.resource_id,d.id,p_payload->>'source_path',p_payload->>'pdf_path','user_upload',
      next_version,p_payload->>'filename',f.file_type,f.expected_size_bytes,
      (p_payload->>'page_count')::integer,(p_payload->>'textless_page_count')::integer,
      p_payload->>'sha256') returning * into v;
    update public.documents set current_version_id=v.id,updated_at=now() where id=d.id;
    published_result := to_jsonb(v);
  elsif s.purpose = 'document_version_replace' then
    select * into d from public.documents where id=(s.destination->>'document_id')::uuid for update;
    if not found then raise exception 'document_not_found'; end if;
    if d.workflow_id is null then
      if d.user_id <> s.user_id then raise exception 'document_edit_denied'; end if;
    else
      select user_id,type into workflow_owner,workflow_type from public.workflows where id=d.workflow_id;
      if not found or workflow_type <> 'assistant' or not (
        workflow_owner = s.user_id or exists (
          select 1 from public.workflow_shares share
          where share.workflow_id=d.workflow_id
            and share.shared_with_email=lower(trim(s.user_email))
            and share.allow_edit = true
        )
      ) then raise exception 'workflow_asset_edit_denied'; end if;
    end if;
    select * into v from public.document_versions
      where id=(s.destination->>'version_id')::uuid and document_id=d.id and deleted_at is null for update;
    if not found then raise exception 'version_not_found'; end if;
    if s.destination ? 'expected_content_sha256' then
      if not (p_payload ? 'expected_storage_path') then raise exception 'invalid_upload_result'; end if;
      if v.storage_path is distinct from p_payload->>'expected_storage_path'
         or v.content_sha256 is distinct from p_payload->>'expected_content_sha256' then
        -- Lost the compare-and-swap: keep the winner, discard only this
        -- upload's own staged objects.
        update public.upload_processing_jobs set status='completed', locked_at=null, locked_by=null,
          claim_token=null, error_code='document_changed', updated_at=now() where id=j.id;
        update public.upload_session_files set status='error', error_code='document_changed', updated_at=now() where id=f.id;
        insert into public.db_jobs(kind,payload,max_attempts)
          values('storage.cleanup',jsonb_build_object('keys',
            to_jsonb(array_remove(cleanup_paths || array[p_payload->>'source_path',p_payload->>'pdf_path'],null)),
            'prefixes','[]'::jsonb),8);
        perform public.refresh_upload_session_status(s.id);
        return jsonb_build_object('status','error','error_code','document_changed');
      end if;
    end if;
    cleanup_paths := cleanup_paths || array[v.storage_path,v.pdf_storage_path];
    update public.document_versions set storage_path=p_payload->>'source_path',pdf_storage_path=p_payload->>'pdf_path',
      filename=f.filename,file_type=f.file_type,size_bytes=f.expected_size_bytes,
      page_count=(p_payload->>'page_count')::integer,
      textless_page_count=(p_payload->>'textless_page_count')::integer,
      content_sha256=p_payload->>'sha256',created_at=now()
      where id=(s.destination->>'version_id')::uuid and document_id=d.id and deleted_at is null returning * into v;
    if not found then raise exception 'version_not_found'; end if;
    update public.documents set current_version_id=v.id,updated_at=now() where id=d.id;
    published_result := to_jsonb(v);
  elsif s.purpose in ('workflow_reference_create','workflow_reference_replace') then
    select coalesce(user_id,s.user_id) into owner_id from public.workflows
      where id=(s.destination->>'workflow_id')::uuid;
    if not found or owner_id <> p_payload->>'owner_id' then raise exception 'workflow_owner_changed'; end if;
    reference_id := case when s.purpose='workflow_reference_replace'
      then (s.destination->>'reference_id')::uuid else f.resource_id end;
    if s.purpose='workflow_reference_create' then
      insert into public.workflow_reference_documents(id,workflow_id,user_id,filename,file_type,
        storage_path,size_bytes,content_hash,updated_at)
      values(reference_id,(s.destination->>'workflow_id')::uuid,owner_id,f.filename,f.file_type,
        p_payload->>'source_path',f.expected_size_bytes,p_payload->>'sha256',now()) returning * into r;
    else
      select * into r from public.workflow_reference_documents
       where id=reference_id and workflow_id=(s.destination->>'workflow_id')::uuid for update;
      if not found then raise exception 'reference_not_found'; end if;
      cleanup_paths := cleanup_paths || array[r.storage_path];
      update public.workflow_reference_documents set filename=f.filename,file_type=f.file_type,
        storage_path=p_payload->>'source_path',size_bytes=f.expected_size_bytes,
        content_hash=p_payload->>'sha256',updated_at=now()
       where id=reference_id and workflow_id=(s.destination->>'workflow_id')::uuid returning * into r;
      if not found then raise exception 'reference_not_found'; end if;
    end if;
    published_result := to_jsonb(r);
  else raise exception 'invalid_upload_purpose'; end if;

  update public.upload_session_files set status='completed',result=published_result,error_code=null,updated_at=now() where id=f.id;
  update public.upload_processing_jobs set status='completed',locked_at=null,locked_by=null,
    claim_token=null,error_code=null,updated_at=now() where id=j.id;
  insert into public.db_jobs(kind,payload,max_attempts)
    values('storage.cleanup',jsonb_build_object('keys',
      to_jsonb(array_remove(cleanup_paths,null)),'prefixes','[]'::jsonb),8);
  insert into public.db_jobs(kind,payload,max_attempts,run_at)
    values('storage.cleanup',jsonb_build_object('keys',
      to_jsonb(array_remove(cleanup_paths,null)),'prefixes','[]'::jsonb),8,
      now()+interval '16 minutes');
  perform public.refresh_upload_session_status(s.id);
  return jsonb_build_object('status','completed','result',published_result);
end; $$;

-- Private PostgREST: these RPCs/triggers are backend service-role only.
do $privileges$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array['guard_workspace_library_membership', 'cleanup_departed_workspace_library', 'search_library_documents', 'get_library_filter_options', 'get_library_document_ids', 'resolve_library_folder_path', 'org_member_private_standalone', 'cleanup_removed_org_member_overrides', 'finish_upload_processing_job']::text[])
  loop
    execute format('revoke all on function %s from public, web_anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end;
$privileges$;

notify pgrst, 'reload schema';
